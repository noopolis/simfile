import { z } from "zod";

import {
  composedDigestSchema,
  composedRunIdSchema,
  parseComposedDigestedContract,
  sealComposedContract,
} from "./contracts.js";
import { parseComposedPhaseJournal, type ComposedPhaseJournal } from "./journal.js";
import {
  commitComposedPhase,
  composedPhasePayload,
  composedPhaseReached,
  type ComposedPhaseContext,
} from "./phase.js";
import { waitForComposedTerminal } from "./supervisionTimeout.js";

export const COMPOSED_RUNNING_RECEIPT_VERSION = "simfile.composed-running.v1" as const;
export const COMPOSED_WORLD_TERMINAL_VERSION = "simfile.composed-world-terminal.v1" as const;

const runningSchema = z.object({
  activation_receipt_digest: composedDigestSchema,
  first_tick_receipt_digest: composedDigestSchema,
  receipt_digest: composedDigestSchema,
  run_id: composedRunIdSchema,
  state: z.literal("running"),
  version: z.literal(COMPOSED_RUNNING_RECEIPT_VERSION),
}).strict();
const terminalSchema = z.object({
  outcome_digest: composedDigestSchema,
  receipt_digest: composedDigestSchema,
  reason: z.enum(["completed", "interrupted"]),
  run_id: composedRunIdSchema,
  running_receipt_digest: composedDigestSchema,
  state: z.literal("terminal"),
  terminal_tick: z.number().int().min(1).max(1_000_000_000),
  version: z.literal(COMPOSED_WORLD_TERMINAL_VERSION),
}).strict();

export type ComposedRunningReceipt = z.infer<typeof runningSchema>;
export type ComposedWorldTerminalReceipt = z.infer<typeof terminalSchema>;

export const parseComposedRunningReceipt = (raw: unknown): ComposedRunningReceipt =>
  parseComposedDigestedContract(raw, runningSchema,
    COMPOSED_RUNNING_RECEIPT_VERSION, "composed running receipt");
export const createComposedRunningReceipt = (
  fields: Omit<ComposedRunningReceipt, "receipt_digest" | "state" | "version">,
): ComposedRunningReceipt => parseComposedRunningReceipt(sealComposedContract(
  COMPOSED_RUNNING_RECEIPT_VERSION,
  { ...fields, state: "running", version: COMPOSED_RUNNING_RECEIPT_VERSION },
));
export const parseComposedWorldTerminalReceipt = (
  raw: unknown,
): ComposedWorldTerminalReceipt => parseComposedDigestedContract(
  raw, terminalSchema, COMPOSED_WORLD_TERMINAL_VERSION, "composed world terminal receipt",
);
export const createComposedWorldTerminalReceipt = (
  fields: Omit<ComposedWorldTerminalReceipt, "receipt_digest" | "state" | "version">,
): ComposedWorldTerminalReceipt => parseComposedWorldTerminalReceipt(sealComposedContract(
  COMPOSED_WORLD_TERMINAL_VERSION,
  { ...fields, state: "terminal", version: COMPOSED_WORLD_TERMINAL_VERSION },
));

export interface ComposedSupervisionPort {
  waitForWorldTerminal(input: Readonly<{
    expected_terminal_tick: number;
    running: ComposedRunningReceipt;
    signal: AbortSignal;
  }>): Promise<unknown>;
}

/** Supervises world time only; participant traffic is outside this boundary. */
export const superviseComposedWorld = async (input: Readonly<{
  context: ComposedPhaseContext;
  expected_terminal_tick: number;
  journal: unknown;
  operator_timeout_ms?: number;
  port: ComposedSupervisionPort;
  /** Internal contract-test seam; production allows five seconds to quiesce. */
  quiescence_timeout_ms?: number;
  signal?: AbortSignal;
}>): Promise<ComposedPhaseJournal> => {
  let journal = parseComposedPhaseJournal(input.journal);
  if (!Number.isSafeInteger(input.expected_terminal_tick) || input.expected_terminal_tick < 1
    || input.expected_terminal_tick > 1_000_000_000) {
    throw new TypeError("composed terminal tick is invalid");
  }
  if (!composedPhaseReached(journal, "tick_1")) {
    throw new TypeError("composed supervision requires tick 1");
  }
  if (!composedPhaseReached(journal, "running")) {
    const activationDigest = composedPhasePayload(journal, "activated").receipt_digest;
    const firstTickDigest = composedPhasePayload(journal, "tick_1").receipt_digest;
    if (typeof activationDigest !== "string" || typeof firstTickDigest !== "string") {
      throw new TypeError("composed supervision prerequisites are invalid");
    }
    const receipt = createComposedRunningReceipt({
      activation_receipt_digest: activationDigest,
      first_tick_receipt_digest: firstTickDigest,
      run_id: journal.request.run_id,
    });
    journal = await commitComposedPhase(journal, "running", {
      receipt, receipt_digest: receipt.receipt_digest, run_id: journal.request.run_id,
    }, input.context);
  }
  const running = parseComposedRunningReceipt(
    composedPhasePayload(journal, "running").receipt,
  );
  if (!composedPhaseReached(journal, "terminal")) {
    const signal = input.signal ?? new AbortController().signal;
    const terminal = parseComposedWorldTerminalReceipt(await waitForComposedTerminal({
      operation: (operationSignal) => input.port.waitForWorldTerminal({
        expected_terminal_tick: input.expected_terminal_tick,
        running,
        signal: operationSignal,
      }),
      operator_timeout_ms: input.operator_timeout_ms ?? 900_000,
      quiescence_timeout_ms: input.quiescence_timeout_ms ?? 5_000,
      signal,
    }));
    if (terminal.run_id !== journal.request.run_id
      || terminal.running_receipt_digest !== running.receipt_digest
      || terminal.terminal_tick !== input.expected_terminal_tick) {
      throw new TypeError("composed terminal correlation is invalid");
    }
    if (terminal.reason !== "completed") {
      throw new TypeError("composed world terminated without completing");
    }
    journal = await commitComposedPhase(journal, "terminal", {
      receipt: terminal, receipt_digest: terminal.receipt_digest, run_id: journal.request.run_id,
    }, input.context);
  }
  return journal;
};
