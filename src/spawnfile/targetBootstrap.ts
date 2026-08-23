import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  currentBootstrapOperation,
  journalBootstrapOperationIntent,
  journalBootstrapOperationObservation,
} from "../compose/bootstrapOperationJournal.js";
import { canonicalComposedJson } from "../compose/json.js";
import type { ComposedJournalSession } from "../compose/journalSession.js";
import {
  parseSpawnfileBundleReceipt,
  runSpawnfileContainerBundle,
  runSpawnfileContainerBundleLookup,
  spawnfileBundleRequestDigest,
  type SpawnfileBundleRequest,
} from "./containerBundleCli.js";
import {
  createCliComposedTargetProvider,
  type CliComposedTargetProvider,
} from "./composedTargetProvider.js";
import { runSpawnfileProcess, type BootstrapSpawnfileCliContext } from "./process.js";
import {
  parseSpawnfileTargetConfigResolution,
  type SpawnfileTargetConfigResolution,
} from "./targetConfigResolution.js";
import { SPAWNFILE_TARGET_DOCKER_TIMEOUT_MS } from "./targetConfigPreview.js";
import {
  parseSpawnfileSelectedTarget,
  runSpawnfileSelectTarget,
  type SpawnfileSelectedTarget,
} from "./targetSelection.js";

const replace = async (session: ComposedJournalSession, next: ReturnType<
  typeof journalBootstrapOperationObservation
>): Promise<void> => session.replace(session.current(), next);

const observe = async (session: ComposedJournalSession, operationId: string,
  state: "completed" | "lookup_required", receipt?: Readonly<Record<string, unknown>>) =>
  replace(session, journalBootstrapOperationObservation(
    session.current(), operationId, state, receipt,
  ));

const resolverArgs = (input: JournaledTargetBootstrapInput): string[] => {
  const args = ["target", "resolve_config", "--context", input.local_context,
    "--evidence-destination", input.evidence_destination,
    "--prepared-plan", input.prepared_plan, "--prepare-evidence-helper",
    "--timeout-ms", String(SPAWNFILE_TARGET_DOCKER_TIMEOUT_MS)];
  if (input.base_image !== "node:22-bookworm-slim") args.push("--base-image", input.base_image);
  if (input.docker_command !== "docker") args.push("--docker-command", input.docker_command);
  return args;
};

export interface JournaledTargetBootstrapInput {
  readonly base_image: string;
  readonly create_bundle_request: (
    selected: SpawnfileSelectedTarget,
  ) => SpawnfileBundleRequest;
  readonly context: BootstrapSpawnfileCliContext;
  readonly docker_command: string;
  readonly evidence_destination: string;
  readonly journal_session: ComposedJournalSession;
  readonly local_context: string;
  readonly prepared_plan: string;
  readonly select_request: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

const resolveTarget = async (
  input: JournaledTargetBootstrapInput,
): Promise<SpawnfileTargetConfigResolution> => {
  const request = { base_image: input.base_image, context: input.local_context,
    docker_command: input.docker_command, evidence_destination: input.evidence_destination,
    prepared_plan_sha256: `sha256:${createHash("sha256")
      .update(await readFile(input.prepared_plan)).digest("hex")}` };
  let operation = currentBootstrapOperation(input.journal_session.current(), "resolve_target_config");
  if (operation === undefined) {
    const current = input.journal_session.current();
    await input.journal_session.replace(current,
      journalBootstrapOperationIntent(current, "resolve_target_config", request));
    operation = currentBootstrapOperation(input.journal_session.current(), "resolve_target_config")!;
  }
  try {
    const raw = await runSpawnfileProcess(input.context, {
      args: resolverArgs(input), signal: input.signal,
    });
    const resolution = parseSpawnfileTargetConfigResolution(
      JSON.parse(raw.stdout) as unknown, input.local_context,
    );
    if (operation.state === "completed"
      && canonicalComposedJson(operation.receipt) !== canonicalComposedJson(resolution.identity)) {
      resolution.config_bytes.fill(0);
      throw new TypeError("Spawnfile target configuration resolution changed");
    }
    if (operation.state !== "completed") {
      await observe(input.journal_session, operation.operation_id, "completed", resolution.identity);
    }
    return resolution;
  } catch (error) {
    const current = currentBootstrapOperation(input.journal_session.current(), "resolve_target_config");
    if (current !== undefined && current.state !== "completed") {
      await observe(input.journal_session, current.operation_id, "lookup_required");
    }
    throw error;
  }
};

const selectTarget = async (input: JournaledTargetBootstrapInput,
  resolution: SpawnfileTargetConfigResolution): Promise<SpawnfileSelectedTarget> => {
  let operation = currentBootstrapOperation(input.journal_session.current(), "select_target");
  if (operation?.state === "completed") return parseSpawnfileSelectedTarget(operation.receipt);
  if (operation === undefined) {
    const current = input.journal_session.current();
    await input.journal_session.replace(current,
      journalBootstrapOperationIntent(current, "select_target", input.select_request));
    operation = currentBootstrapOperation(input.journal_session.current(), "select_target")!;
  }
  try {
    const receipt = await runSpawnfileSelectTarget({ context: input.context,
      request: input.select_request, signal: input.signal,
      target_config: resolution.config_bytes });
    await observe(input.journal_session, operation.operation_id, "completed", receipt);
    return receipt;
  } catch (error) {
    await observe(input.journal_session, operation.operation_id, "lookup_required");
    throw error;
  }
};

const prepareBundle = async (input: JournaledTargetBootstrapInput,
  resolution: SpawnfileTargetConfigResolution, selected: SpawnfileSelectedTarget) => {
  const request = input.create_bundle_request(selected);
  const summary = { idempotency_key: request.idempotency_key,
    request_digest: spawnfileBundleRequestDigest(request) };
  let operation = currentBootstrapOperation(input.journal_session.current(), "prepare_container_bundle");
  if (operation?.state === "completed") return parseSpawnfileBundleReceipt(operation.receipt);
  if (operation === undefined) {
    const current = input.journal_session.current();
    await input.journal_session.replace(current,
      journalBootstrapOperationIntent(current, "prepare_container_bundle", summary));
    operation = currentBootstrapOperation(input.journal_session.current(), "prepare_container_bundle")!;
  }
  try {
    const lookup = await runSpawnfileContainerBundleLookup({ context: input.context,
      ...summary, signal: input.signal, target_config: resolution.config_bytes });
    const receipt = lookup.status === "completed" ? lookup.receipt
      : await runSpawnfileContainerBundle({ command: lookup.status === "pending"
        ? "recover_container_bundle" : "prepare_container_bundle", context: input.context,
      request, signal: input.signal, target_config: resolution.config_bytes });
    await observe(input.journal_session, operation.operation_id, "completed", receipt);
    return receipt;
  } catch (error) {
    await observe(input.journal_session, operation.operation_id, "lookup_required");
    throw error;
  }
};

export const bootstrapJournaledTarget = async (input: JournaledTargetBootstrapInput): Promise<{
  provider: CliComposedTargetProvider;
  resolution: SpawnfileTargetConfigResolution["identity"];
  selected_target: SpawnfileSelectedTarget;
}> => {
  const resolution = await resolveTarget(input);
  try {
    const selected = await selectTarget(input, resolution);
    await prepareBundle(input, resolution, selected);
    const provider = await createCliComposedTargetProvider({ ...input,
      expected_resolution: resolution.identity, resolved_resolution: resolution });
    return Object.freeze({ provider, resolution: resolution.identity, selected_target: selected });
  } catch (error) {
    resolution.config_bytes.fill(0);
    throw error;
  }
};
