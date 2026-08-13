import { z } from "zod";

import type { ComposedPhaseJournal } from "../compose/journal.js";
import {
  createComposedWorldTerminalReceipt,
  type ComposedRunningReceipt,
} from "../compose/supervision.js";
import type { ComposedExecution } from "../compose/execution.js";
import { readTargetPublicJson } from "./targetReceipts.js";

const terminalSignal = z.object({
  outcome_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  reason: z.enum(["completed", "interrupted"]),
  run_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
  terminal_tick: z.number().int().min(1).max(1_000_000_000),
  version: z.literal("simfile.composed-world-terminal-signal.v1"),
}).strict();
const waitForPoll = (signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const timer = setTimeout(done, 1_000);
  function done(): void { signal.removeEventListener("abort", aborted); resolve(); }
  function aborted(): void {
    clearTimeout(timer); signal.removeEventListener("abort", aborted); reject(signal.reason);
  }
  signal.addEventListener("abort", aborted, { once: true });
});

/** Polls only one world-owned public terminal artifact; participant state is absent. */
export const waitForProductionWorldTerminal = async (input: Readonly<{
  journal: ComposedPhaseJournal;
  provider: ComposedExecution["provider"];
  run_target(command: string, request: Readonly<Record<string, unknown>>,
    signal: AbortSignal): Promise<unknown>;
  running: ComposedRunningReceipt;
  selected_target: ComposedExecution["configuration"]["topology_expectation"]["selected_target"];
  service_handle: string;
  signal: AbortSignal;
}>): Promise<unknown> => {
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
      break;
    } catch {
      if (input.signal.aborted) throw input.signal.reason;
      await waitForPoll(input.signal);
    }
  }
  const observed = terminalSignal.parse(readTargetPublicJson({
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
