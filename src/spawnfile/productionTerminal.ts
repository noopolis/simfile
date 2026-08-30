import type { ComposedPhaseJournal } from "../compose/journal.js";
import {
  createComposedWorldTerminalReceipt,
  type ComposedRunningReceipt,
} from "../compose/supervision.js";
import type { ComposedExecution } from "../compose/execution.js";
import { parseComposedWorldTerminalSignal } from
  "../world-artifact/terminalSignal.js";
import {
  isTargetPublicArtifactNotPresent,
  readTargetPublicJson,
} from "./targetReceipts.js";

/** Exact retry signal for a terminal artifact that has not been published yet. */
export class ProductionWorldTerminalNotPresentError extends Error {
  public constructor() {
    super("world terminal artifact is not present yet");
    this.name = "ProductionWorldTerminalNotPresentError";
  }
}

const waitForPoll = (
  signal: AbortSignal,
  pollIntervalMs: number,
): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const timer = setTimeout(done, pollIntervalMs);
  function done(): void { signal.removeEventListener("abort", aborted); resolve(); }
  function aborted(): void {
    clearTimeout(timer); signal.removeEventListener("abort", aborted); reject(signal.reason);
  }
  signal.addEventListener("abort", aborted, { once: true });
});

/** Polls only one world-owned public terminal artifact; participant state is absent. */
export const waitForProductionWorldTerminal = async (input: Readonly<{
  journal: ComposedPhaseJournal;
  provider: Pick<ComposedExecution["provider"], "terminal_artifact">;
  run_target(command: string, request: Readonly<Record<string, unknown>>,
    signal: AbortSignal): Promise<unknown>;
  running: ComposedRunningReceipt;
  selected_target: ComposedExecution["configuration"]["topology_expectation"]["selected_target"];
  service_handle: string;
  signal: AbortSignal;
  /** Internal test seam; production polling remains one second. */
  poll_interval_ms?: number;
}>): Promise<unknown> => {
  const pollIntervalMs = input.poll_interval_ms ?? 1_000;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 60_000) {
    throw new TypeError("world terminal poll interval is invalid");
  }
  const artifact = input.provider.terminal_artifact;
  const request = {
    artifact: { ...artifact, media_type: "application/json" },
    descriptor_digest: input.journal.request.descriptor_digest,
    run_id: input.journal.request.run_id,
    selected_target: input.selected_target,
    version: "spawnfile.target-public-artifact-snapshot.request.v1",
    world_service_handle: input.service_handle,
  };
  let raw: unknown;
  while (true) {
    try {
      raw = await input.run_target("snapshot_public_artifact", request, input.signal);
      if (isTargetPublicArtifactNotPresent({
        artifact_id: artifact.id, raw, request,
      })) throw new ProductionWorldTerminalNotPresentError();
      break;
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason;
      if (!(error instanceof ProductionWorldTerminalNotPresentError)) throw error;
      await waitForPoll(input.signal, pollIntervalMs);
    }
  }
  const observed = parseComposedWorldTerminalSignal(readTargetPublicJson({
    artifact_id: artifact.id, raw, request,
  }));
  if (observed.run_id !== input.journal.request.run_id) {
    throw new TypeError("world terminal signal correlation is invalid");
  }
  return createComposedWorldTerminalReceipt({
    outcome_digest: observed.outcome_digest, reason: observed.reason,
    run_id: observed.run_id, running_receipt_digest: input.running.receipt_digest,
    terminal_tick: observed.terminal_tick,
  });
};
