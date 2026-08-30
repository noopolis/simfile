import { z } from "zod";

import type { ComposedExecution } from "../compose/execution.js";
import type { ComposedPhaseJournal } from "../compose/journal.js";
import type { ComposedJournalSession } from "../compose/journalSession.js";
import { composedPhasePayload } from "../compose/phase.js";
import {
  parseComposedWorldResourceReceipt,
  parseComposedWorldServiceReceipt,
} from "../compose/startup-world.js";
import {
  unavailableComposedTargetProvider,
  type ComposedTargetProvider,
} from "./composedTargetProvider.js";
import { parseTargetResourceReceipt } from "./targetReceipts.js";
import { COMPOSED_SPAWNFILE_OPERATION_TIMEOUT_MS } from "./process.js";

const handle = z.string().regex(/^opaque_[a-z0-9]{16,64}$/u);
export const productionRecord = (value: unknown): Record<string, unknown> =>
  z.record(z.string(), z.unknown()).parse(value);

const operationTuple = (raw: unknown) => {
  const receipt = parseTargetResourceReceipt(raw);
  if (receipt.result_handle === null) throw new TypeError("Spawnfile target result handle is missing");
  return {
    operation_handle: receipt.operation_handle,
    request_digest: receipt.request_digest,
    result_handle: receipt.result_handle,
  };
};

export const createProductionTargetDriver = (input: Readonly<{
  execution: ComposedExecution;
  journal_session: ComposedJournalSession;
  target_provider?: ComposedTargetProvider;
}>) => {
  const provider = input.execution.provider;
  const selectedTarget = input.execution.configuration.topology_expectation.selected_target;
  const environment = provider.process_environment === undefined
    ? process.env
    : { ...process.env, ...provider.process_environment };
  const cli = {
    bootstrapLocalExecutableIdentity: {
      path: provider.spawnfile_bin,
      sha256: provider.spawnfile_executable_sha256 as `sha256:${string}`,
    },
    cwd: provider.spawnfile_cwd,
    env: environment,
    spawnfileBin: provider.spawnfile_bin,
    timeoutMs: COMPOSED_SPAWNFILE_OPERATION_TIMEOUT_MS,
  };
  const guard = () => input.journal_session.assertCurrent();
  const targetProvider = input.target_provider ?? unavailableComposedTargetProvider();
  const load = async () => {
    await guard();
    return input.journal_session.current();
  };
  const runTarget = async (
    command: string,
    request: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<unknown> => {
    await guard();
    return targetProvider.request({ command, journal_session: input.journal_session, request, signal });
  };
  const completeTarget = async (command: string, request: Readonly<Record<string, unknown>>,
    receipt: Readonly<Record<string, unknown>>): Promise<void> => {
    await input.journal_session.assertCurrent();
    await targetProvider.complete({ command, journal_session: input.journal_session, receipt, request });
  };
  const mutation = (
    journal: ComposedPhaseJournal,
    operation: string,
    idempotencyKey: string,
    expectedRevision: number,
    extra: Readonly<Record<string, unknown>>,
  ) => ({
    descriptor_digest: journal.request.descriptor_digest,
    expected_revision: expectedRevision,
    idempotency_key: idempotencyKey,
    operation,
    run_id: journal.request.run_id,
    selected_target: selectedTarget,
    version: "spawnfile.target-resource.request.v1",
    ...extra,
  });
  const topologyRequest = async () => {
    const journal = await load();
    const preparation = productionRecord(composedPhasePayload(journal, "prepared").preparation);
    const resources = productionRecord(preparation.resources);
    const dataNetwork = productionRecord(resources.data_network);
    const created = parseComposedWorldResourceReceipt(
      composedPhasePayload(journal, "world_created").receipt,
    );
    const started = parseComposedWorldServiceReceipt(
      composedPhasePayload(journal, "world_started_paused").receipt,
    );
    const organization = productionRecord(
      composedPhasePayload(journal, "organization_started").up_receipt,
    );
    return {
      data_network: {
        operation_handle: handle.parse(dataNetwork.operation_handle),
        request_digest: z.string().parse(dataNetwork.request_digest),
        result_handle: handle.parse(dataNetwork.result_handle),
      },
      descriptor_digest: journal.request.descriptor_digest,
      organization_attachment: operationTuple(organization.target_attachment),
      run_id: journal.request.run_id,
      selected_target: selectedTarget,
      version: "spawnfile.target-topology-attestation.request.v1",
      world_service: {
        create: operationTuple(created.target_operation),
        start: operationTuple(started.target_operation),
      },
    } as const;
  };
  return Object.freeze({ cli, completeTarget, guard, load, mutation, runTarget, selectedTarget, targetProvider, topologyRequest });
};
