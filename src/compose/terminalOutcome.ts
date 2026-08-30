import type { ComposedReplayReceipt } from "./replay.js";
import { parseComposedPhaseJournal } from "./journal.js";
import { composedPhasePayload } from "./phase.js";
import {
  parseComposedWorldTerminalReceipt,
  type ComposedWorldTerminalReceipt,
} from "./supervision.js";

/** Binds the public terminal signal to the exact replayed terminal-state bytes. */
export const verifyComposedTerminalOutcome = (
  rawJournal: unknown,
  replay: ComposedReplayReceipt,
): ComposedWorldTerminalReceipt => {
  const journal = parseComposedPhaseJournal(rawJournal);
  const terminal = parseComposedWorldTerminalReceipt(
    composedPhasePayload(journal, "terminal").receipt,
  );
  if (terminal.run_id !== replay.run_id
    || terminal.terminal_tick !== replay.terminal_tick
    || terminal.outcome_digest !== `sha256:${replay.terminal_state_sha256}`) {
    throw new TypeError("composed terminal outcome does not match exact replay");
  }
  return terminal;
};
