import type { ComposedJournalSession } from "../compose/journalSession.js";
import {
  currentBootstrapOperation,
  journalBootstrapOperationIntent,
  journalBootstrapOperationObservation,
} from "../compose/bootstrapOperationJournal.js";
import { canonicalComposedJson } from "../compose/json.js";
import { currentTargetOperation, journalTargetOperationIntent, journalTargetOperationObservation } from "../compose/operationJournal.js";
import { runSpawnfileComposedPreparation, runSpawnfileTargetCommand } from "./cli.js";
import { runSpawnfileProcess, type BootstrapSpawnfileCliContext } from "./process.js";
import { parseSpawnfileTargetConfigResolution, type SpawnfileTargetConfigResolution } from "./targetConfigResolution.js";
import { SPAWNFILE_TARGET_DOCKER_TIMEOUT_MS } from "./targetConfigPreview.js";
import { parseTargetOperationLookup, type TargetOperationLookup } from "./targetOperationLookup.js";

/**
 * Simfile's internal seam for the admitted released Spawnfile target contract.
 * It deliberately carries opaque public requests and receipts only: Simfile
 * does not reconstruct target configuration, choose a target, or accept an
 * operator helper/environment ABI.
 */
export interface ComposedTargetProvider {
  prepare(input: Readonly<{
    journal_session: ComposedJournalSession;
    request: Readonly<Record<string, unknown>>;
    signal: AbortSignal;
  }>): Promise<unknown>;
  lookup(input: Readonly<{
    journal_session: ComposedJournalSession;
    request: Readonly<Record<string, unknown>>;
    signal: AbortSignal;
  }>): Promise<TargetOperationLookup>;
  complete(input: Readonly<{
    command: string;
    journal_session: ComposedJournalSession;
    receipt: Readonly<Record<string, unknown>>;
    request: Readonly<Record<string, unknown>>;
  }>): Promise<void>;
  request(input: Readonly<{
    command: string;
    journal_session: ComposedJournalSession;
    request: Readonly<Record<string, unknown>>;
    signal: AbortSignal;
  }>): Promise<unknown>;
}

export interface CliComposedTargetProvider extends ComposedTargetProvider {
  readonly resolution: SpawnfileTargetConfigResolution["identity"];
  close(): void;
}

/** Builds the only admitted target adapter from Spawnfile's documented resolver. */
export const createCliComposedTargetProvider = async (input: Readonly<{
  base_image: string;
  context: BootstrapSpawnfileCliContext;
  docker_command: string;
  evidence_destination: string;
  local_context: string;
  prepared_plan: string;
  expected_resolution?: SpawnfileTargetConfigResolution["identity"];
  resolved_resolution?: SpawnfileTargetConfigResolution;
  signal?: AbortSignal;
}>): Promise<CliComposedTargetProvider> => {
  const args = ["target", "resolve_config",
    "--context", input.local_context, "--evidence-destination", input.evidence_destination,
    "--prepared-plan", input.prepared_plan, "--prepare-evidence-helper",
    "--timeout-ms", String(SPAWNFILE_TARGET_DOCKER_TIMEOUT_MS)];
  if (input.base_image !== "node:22-bookworm-slim") {
    args.push("--base-image", input.base_image);
  }
  if (input.docker_command !== "docker") {
    args.push("--docker-command", input.docker_command);
  }
  const resolved = input.resolved_resolution === undefined
    ? await runSpawnfileProcess(input.context, { args, signal: input.signal }) : undefined;
  let state = input.resolved_resolution ?? parseSpawnfileTargetConfigResolution(
    JSON.parse(resolved!.stdout) as unknown, input.local_context,
  );
  if (input.expected_resolution !== undefined
    && canonicalComposedJson(state.identity) !== canonicalComposedJson(input.expected_resolution)) {
    state.config_bytes.fill(0);
    throw new TypeError("Spawnfile target configuration resolution changed");
  }
  const assertOpen = (): Uint8Array => {
    if (state.config_bytes.byteLength === 0) throw new TypeError("Spawnfile target provider is closed");
    return state.config_bytes;
  };
  const mutation = new Set(["attach_organization", "cleanup_run", "create_world_service",
    "detach_organization", "export_evidence_volume", "revoke_secret_bindings", "start_world_service", "stop_world_service"]);
  const provider: CliComposedTargetProvider = {
    resolution: state.identity,
    async prepare({ journal_session, request, signal }) {
      let current = journal_session.current();
      let operation = currentBootstrapOperation(current, "prepare_composed_run");
      if (operation?.state === "completed") return operation.receipt;
      if (operation === undefined) {
        const intent = journalBootstrapOperationIntent(current, "prepare_composed_run", request);
        await journal_session.replace(current, intent);
        current = journal_session.current();
        operation = currentBootstrapOperation(current, "prepare_composed_run")!;
      }
      try {
        const receipt = await runSpawnfileComposedPreparation(input.context, {
          request: request as never, signal, targetConfigStdin: assertOpen(),
        });
        const completed = journalBootstrapOperationObservation(
          journal_session.current(), operation.operation_id, "completed", receipt,
        );
        await journal_session.replace(journal_session.current(), completed);
        return receipt;
      } catch (error) {
        const latest = journal_session.current();
        const pending = currentBootstrapOperation(latest, "prepare_composed_run");
        if (pending !== undefined && pending.state !== "completed") {
          await journal_session.replace(latest, journalBootstrapOperationObservation(
            latest, pending.operation_id, "lookup_required",
          ));
        }
        throw error;
      }
    },
    async request({ command, journal_session, request, signal }) {
      if (!mutation.has(command)) {
        return runSpawnfileTargetCommand(input.context, { command, request, signal, targetConfigStdin: assertOpen() });
      }
      const current = journal_session.current();
      const prior = currentTargetOperation(current, command, request);
      if (prior?.state === "completed") return prior.target_receipt;
      let operation = prior;
      if (operation !== undefined) {
        const observed = await provider.lookup({ journal_session, request, signal });
        const latest = journal_session.current();
        if (observed.status === "completed") {
          // The caller must verify the typed operation receipt before calling
          // complete(); lookup alone never turns an observation into truth.
          return observed.target_receipt;
        }
        const state = observed.status === "pending" ? "pending" : "not_applied";
        await journal_session.replace(latest, journalTargetOperationObservation(
          latest, String(operation.operation_id), state,
        ));
        if (observed.status === "pending") {
          throw new TypeError("Spawnfile target operation remains pending");
        }
      } else {
        const intent = journalTargetOperationIntent(current, command, request);
        operation = intent.operations!.at(-1)!;
        await journal_session.replace(current, intent);
      }
      try {
        return await runSpawnfileTargetCommand(input.context, { command, request, signal,
          targetConfigStdin: assertOpen() });
      } catch (error) {
        const latest = journal_session.current();
        const pending = journalTargetOperationObservation(latest,
          String(operation.operation_id), "lookup_required");
        await journal_session.replace(latest, pending);
        throw error;
      }
    },
    async complete({ command, journal_session, receipt, request }) {
      const current = journal_session.current();
      const pending = currentTargetOperation(current, command, request);
      if (pending?.state === "completed") {
        if (canonicalComposedJson(pending.target_receipt)
          !== canonicalComposedJson(receipt)) {
          throw new TypeError("completed target mutation receipt changed");
        }
        return;
      }
      if (pending === undefined) {
        throw new TypeError("target mutation completion has no durable intent");
      }
      const completed = journalTargetOperationObservation(current, String(pending.operation_id), "completed", receipt);
      await journal_session.replace(current, completed);
    },
    async lookup({ request, signal }) {
      const lookupConfig = new TextEncoder().encode(JSON.stringify({ context: state.identity.context,
        version: "spawnfile.target-lookup-config.v1" }));
      try {
        const raw = await runSpawnfileTargetCommand(input.context, { command: "lookup_operation", request,
          signal, targetConfigStdin: lookupConfig });
        return parseTargetOperationLookup(raw, request);
      } finally { lookupConfig.fill(0); }
    },
    close() { state.config_bytes.fill(0); state = { ...state, config_bytes: new Uint8Array() }; },
  };
  return Object.freeze(provider);
};

/** Explicit fail-closed provider for routes that have not completed admission. */
export const unavailableComposedTargetProvider = (): ComposedTargetProvider => {
  const unavailable = (): never => {
    throw new TypeError(
      "Simfile requires a released consumer-neutral Spawnfile target provider; "
      + "manual target configuration is not supported",
    );
  };
  return Object.freeze({ prepare: unavailable, request: unavailable, lookup: unavailable, complete: unavailable });
};
