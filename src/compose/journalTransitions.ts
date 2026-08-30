import {
  composedBootstrapDigest,
  parseComposedBootstrapBinding,
} from "./bootstrapAuthority.js";
import { COMPOSED_EXECUTION_VERSION, parseComposedExecution } from "./execution.js";
import { assertSecretFreeComposedJson, digestComposedJson } from "./json.js";
import {
  COMPOSED_PHASE_JOURNAL_BOOTSTRAP_VERSION,
  type ComposedPhaseJournal,
} from "./journalSchema.js";
import {
  composedJournalAuthorityDigest,
  composedPhasePayloadDigest,
  parseComposedPhaseJournal,
  sealComposedPhaseJournal,
} from "./journalValidation.js";
import { composedRunPhaseIndex, nextComposedRunPhase, type ComposedRunPhase } from "./types.js";

export const appendComposedPhase = (rawJournal: unknown, phase: ComposedRunPhase,
  rawPayload: Record<string, unknown>, recordedAt: string): ComposedPhaseJournal => {
  const journal = parseComposedPhaseJournal(rawJournal);
  assertSecretFreeComposedJson(rawPayload);
  if (rawPayload.run_id !== journal.request.run_id) {
    throw new TypeError("composed phase run correlation is invalid");
  }
  const requestedIndex = composedRunPhaseIndex(phase);
  const currentIndex = composedRunPhaseIndex(journal.current_phase);
  if (requestedIndex <= currentIndex) {
    const existing = journal.entries[requestedIndex];
    if (!existing || existing.payload_digest !== composedPhasePayloadDigest(phase, rawPayload)) {
      throw new TypeError("composed phase replay is contradictory");
    }
    return journal;
  }
  if (requestedIndex !== currentIndex + 1 || journal.state === "complete") {
    throw new TypeError("composed phase transition is not monotonic");
  }
  const entries = [...journal.entries, {
    payload: rawPayload, payload_digest: composedPhasePayloadDigest(phase, rawPayload), phase,
    recorded_at: recordedAt, sequence: requestedIndex,
  }];
  const { journal_digest: _digest, ...body } = journal;
  return sealComposedPhaseJournal({ ...body, current_phase: phase, entries,
    interruption: null, state: phase === "completed" ? "complete" : "active" });
};

/** Binds provider identity only after all bootstrap mutation receipts are verified. */
export const bindComposedJournalExecution = (rawJournal: unknown,
  rawExecution: unknown, rawBinding?: unknown): ComposedPhaseJournal => {
  const journal = parseComposedPhaseJournal(rawJournal);
  const execution = parseComposedExecution(rawExecution);
  if (journal.execution !== undefined || journal.current_phase !== "requested"
    || (journal.operations?.length ?? 0) !== 0
    || journal.bootstrap_operations?.length !== 4
    || journal.bootstrap_operations.some(({ state }) => state !== "completed")
    || execution.configuration.readiness_expectation.run_id !== journal.request.run_id
    || execution.configuration.readiness_expectation.bundle_digest !== journal.request.world.bundle_digest
    || execution.configuration.organization_expectation.world_binding_digest
      !== journal.request.organization.world_bindings_digest) {
    throw new TypeError("composed execution binding is invalid");
  }
  const binding = journal.version === COMPOSED_PHASE_JOURNAL_BOOTSTRAP_VERSION
    ? parseComposedBootstrapBinding(rawBinding) : undefined;
  const authority = composedJournalAuthorityDigest({
    ...(journal.bootstrap === undefined ? {} : { bootstrap: journal.bootstrap }),
    execution, genesis_nonce: journal.genesis_nonce,
    recorded_at: journal.entries[0]!.recorded_at, request_digest: journal.request_digest,
  });
  if (binding !== undefined && (binding.bootstrap_authority_digest !== authority
    || binding.execution_digest !== digestComposedJson(COMPOSED_EXECUTION_VERSION, execution)
    || binding.request_digest !== journal.request_digest || binding.run_id !== journal.request.run_id
    || journal.bootstrap === undefined
    || binding.bootstrap_digest !== composedBootstrapDigest(journal.bootstrap))) {
    throw new TypeError("composed bootstrap binding is invalid");
  }
  const { journal_digest: _digest, ...body } = journal;
  return sealComposedPhaseJournal({ ...body, authority_digest: authority,
    ...(binding === undefined ? {} : { bootstrap_binding: binding }), execution });
};

export const markComposedJournalRecoverable = (rawJournal: unknown, input: Readonly<{
  recovery_command: string;
  signal: "SIGINT" | "SIGTERM" | "restart" | "failure";
}>): ComposedPhaseJournal => {
  const journal = parseComposedPhaseJournal(rawJournal);
  const nextPhase = nextComposedRunPhase(journal.current_phase);
  if (nextPhase === null || journal.state === "complete") {
    throw new TypeError("completed journal cannot require recovery");
  }
  const { journal_digest: _digest, ...body } = journal;
  return sealComposedPhaseJournal({ ...body, interruption: {
    next_phase: nextPhase, recovery_command: input.recovery_command, signal: input.signal,
  }, state: "recoverable" });
};
