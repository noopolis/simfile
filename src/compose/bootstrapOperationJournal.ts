import { parseComposedPhaseJournal, type ComposedPhaseJournal } from "./journal.js";
import { digestComposedJson } from "./json.js";
import {
  COMPOSED_BOOTSTRAP_OPERATION_KINDS,
  type ComposedBootstrapOperation,
} from "./bootstrapOperationContract.js";

export type BootstrapOperationKind =
  (typeof COMPOSED_BOOTSTRAP_OPERATION_KINDS)[number];
export type BootstrapOperationState = ComposedBootstrapOperation["state"];

const requestDigest = (
  kind: BootstrapOperationKind,
  request: Readonly<Record<string, unknown>>,
): `sha256:${string}` => digestComposedJson(
  "simfile.composed-bootstrap-operation-request.v1", { kind, request },
);

const replace = (
  journal: ComposedPhaseJournal,
  bootstrap_operations: readonly Record<string, unknown>[],
): ComposedPhaseJournal => {
  const { journal_digest: _digest, ...body } = journal;
  const next = { ...body, bootstrap_operations };
  return parseComposedPhaseJournal({ ...next,
    journal_digest: digestComposedJson(journal.version, next) });
};

export const currentBootstrapOperation = (
  journal: ComposedPhaseJournal,
  kind: BootstrapOperationKind,
): ComposedBootstrapOperation | undefined => journal.bootstrap_operations?.find(
  (operation) => operation.kind === kind,
);

export const journalBootstrapOperationIntent = (
  journal: ComposedPhaseJournal,
  kind: BootstrapOperationKind,
  request: Readonly<Record<string, unknown>>,
): ComposedPhaseJournal => {
  const operations = journal.bootstrap_operations ?? [];
  const sequence = operations.length;
  const expectedKind = COMPOSED_BOOTSTRAP_OPERATION_KINDS[sequence];
  if (journal.bootstrap === undefined || expectedKind !== kind
    || currentBootstrapOperation(journal, kind) !== undefined
    || operations.some(({ state }) => state !== "completed")
    || (kind === "prepare_composed_run") !== (journal.execution !== undefined)) {
    throw new TypeError("composed bootstrap operation intent is invalid");
  }
  const request_digest = requestDigest(kind, request);
  return replace(journal, [...operations, {
    kind,
    operation_id: digestComposedJson("simfile.composed-bootstrap-operation.v1", {
      kind, request_digest, sequence,
    }),
    recorded_at: new Date().toISOString(),
    request,
    request_digest,
    sequence,
    state: "intent_durable",
  }]);
};

export const journalBootstrapOperationObservation = (
  journal: ComposedPhaseJournal,
  operationId: string,
  state: Exclude<BootstrapOperationState, "intent_durable">,
  receipt?: Readonly<Record<string, unknown>>,
): ComposedPhaseJournal => {
  const operations = [...(journal.bootstrap_operations ?? [])];
  const index = operations.findIndex((operation) => operation.operation_id === operationId);
  const current = operations[index];
  if (current === undefined || current.state === "completed"
    || ((state === "completed") !== (receipt !== undefined))) {
    throw new TypeError("composed bootstrap operation observation is invalid");
  }
  operations[index] = {
    ...current,
    state,
    ...(receipt === undefined ? {} : { receipt }),
  };
  return replace(journal, operations);
};
