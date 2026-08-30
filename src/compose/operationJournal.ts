import { appendComposedPhase, parseComposedPhaseJournal, type ComposedPhaseJournal } from "./journal.js";
import { digestComposedJson } from "./json.js";

export type ComposedOperationState = "intent_durable" | "completed" | "lookup_required" | "not_applied" | "pending";

const replaceOperations = (journal: ComposedPhaseJournal, operations: readonly Record<string, unknown>[]): ComposedPhaseJournal => {
  const { journal_digest: _digest, ...body } = journal;
  return parseComposedPhaseJournal({ ...body, operations,
    journal_digest: digestComposedJson(journal.version, { ...body, operations }) });
};
const record = (journal: ComposedPhaseJournal, command: string, request: Readonly<Record<string, unknown>>,
  state: ComposedOperationState, receipt?: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const sequence = journal.operations?.length ?? 0;
  const requestDigest = digestComposedJson("spawnfile.target-resource.request.v1", request);
  return { command, operation_id: digestComposedJson("simfile.composed-operation.v1", {
    command, request_digest: requestDigest, sequence }), recorded_at: new Date().toISOString(), request,
    request_digest: requestDigest, sequence, state, ...(receipt === undefined ? {} : { target_receipt: receipt }) };
};

/** Appends an fsync-ready immutable target-mutation intent before invoking Spawnfile. */
export const journalTargetOperationIntent = (journal: ComposedPhaseJournal, command: string,
  request: Readonly<Record<string, unknown>>): ComposedPhaseJournal => replaceOperations(journal, [
  ...(journal.operations ?? []), record(journal, command, request, "intent_durable"),
]);
export const journalTargetOperationObservation = (journal: ComposedPhaseJournal, operation_id: string,
  state: Exclude<ComposedOperationState, "intent_durable">, receipt?: Readonly<Record<string, unknown>>): ComposedPhaseJournal => {
  const operations = [...(journal.operations ?? [])];
  const current = operations.find((entry) => entry.operation_id === operation_id);
  if (current === undefined || current.state === "completed"
    || ((state === "completed") !== (receipt !== undefined))) {
    throw new TypeError("composed operation observation is invalid");
  }
  operations[current.sequence as number] = { ...current, state, ...(receipt === undefined ? {} : { target_receipt: receipt }) };
  return replaceOperations(journal, operations);
};
export const currentTargetOperation = (journal: ComposedPhaseJournal, command: string,
  request: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | undefined => {
  const request_digest = digestComposedJson("spawnfile.target-resource.request.v1", request);
  return journal.operations?.find((entry) => entry.command === command && entry.request_digest === request_digest);
};
