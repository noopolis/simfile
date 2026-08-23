import {
  composedBootstrapDigest,
  parseComposedBootstrapBinding,
  parseComposedBootstrapCapsule,
  type ComposedBootstrapCapsule,
} from "./bootstrapAuthority.js";
import { COMPOSED_BOOTSTRAP_OPERATION_KINDS } from "./bootstrapOperationContract.js";
import {
  COMPOSED_EXECUTION_VERSION,
  parseComposedExecution,
  type ComposedExecution,
} from "./execution.js";
import {
  assertSecretFreeComposedJson,
  canonicalComposedJson,
  digestComposedJson,
} from "./json.js";
import {
  COMPOSED_JOURNAL_AUTHORITY_VERSION,
  COMPOSED_PHASE_JOURNAL_BOOTSTRAP_VERSION,
  COMPOSED_PHASE_JOURNAL_VERSION,
  composedPhaseJournalSchema,
  type ComposedPhaseJournal,
} from "./journalSchema.js";
import { createComposedRunRequestDigest } from "./request.js";
import {
  COMPOSED_RUN_PHASES,
  composedRunPhaseIndex,
  nextComposedRunPhase,
  type ComposedRunPhase,
} from "./types.js";

export const composedPhasePayloadDigest = (
  phase: ComposedRunPhase,
  value: unknown,
): `sha256:${string}` => digestComposedJson(`simfile.composed-phase.${phase}.v1`, value);

export const composedJournalAuthorityDigest = (input: Readonly<{
  bootstrap?: ComposedBootstrapCapsule;
  execution?: ComposedExecution;
  genesis_nonce: string;
  recorded_at: string;
  request_digest: string;
}>): `sha256:${string}` => digestComposedJson(COMPOSED_JOURNAL_AUTHORITY_VERSION, {
  bootstrap_digest: input.bootstrap === undefined ? null : composedBootstrapDigest(input.bootstrap),
  execution_digest: input.bootstrap !== undefined || input.execution === undefined ? null
    : digestComposedJson(COMPOSED_EXECUTION_VERSION, input.execution),
  genesis_nonce: input.genesis_nonce,
  recorded_at: input.recorded_at,
  request_digest: input.request_digest,
});

const assertBinding = (journal: ComposedPhaseJournal): void => {
  if (journal.bootstrap_binding === undefined) {
    if (journal.version === COMPOSED_PHASE_JOURNAL_BOOTSTRAP_VERSION
      && journal.execution !== undefined) {
      throw new TypeError("composed bootstrap execution is unbound");
    }
    return;
  }
  const binding = parseComposedBootstrapBinding(journal.bootstrap_binding);
  const bootstrap = journal.bootstrap;
  const execution = journal.execution;
  const resolution = execution?.provider.target_resolution;
  const selected = execution?.configuration.topology_expectation.selected_target;
  if (bootstrap === undefined || execution === undefined
    || binding.bootstrap_authority_digest !== journal.authority_digest
    || binding.bootstrap_digest !== composedBootstrapDigest(bootstrap)
    || binding.execution_digest !== digestComposedJson(COMPOSED_EXECUTION_VERSION, execution)
    || binding.request_digest !== journal.request_digest || binding.run_id !== journal.request.run_id
    || resolution === undefined || selected === undefined
    || binding.target.context !== resolution.context
    || binding.target.target_config_digest !== resolution.target_config_digest
    || canonicalComposedJson(binding.target.prepared_evidence_helper)
      !== canonicalComposedJson(resolution.prepared_evidence_helper)
    || canonicalComposedJson(binding.target.selected_target) !== canonicalComposedJson(selected)
    || binding.target.selected_target_receipt_digest
      !== execution.configuration.organization_expectation.selected_target_receipt_digest) {
    throw new TypeError("composed bootstrap binding correlation is invalid");
  }
};

const assertEntries = (journal: ComposedPhaseJournal): void => {
  let previousTime = -Infinity;
  for (const [index, item] of journal.entries.entries()) {
    assertSecretFreeComposedJson(item.payload);
    const time = Date.parse(item.recorded_at);
    if (item.phase !== COMPOSED_RUN_PHASES[index] || item.sequence !== index
      || item.payload.run_id !== journal.request.run_id
      || item.payload_digest !== composedPhasePayloadDigest(item.phase, item.payload)
      || !Number.isFinite(time) || time < previousTime) {
      throw new TypeError("composed journal transition is invalid");
    }
    previousTime = time;
  }
};

const assertOperations = (journal: ComposedPhaseJournal): void => {
  for (const [index, item] of (journal.operations ?? []).entries()) {
    assertSecretFreeComposedJson(item.request);
    if (item.sequence !== index || item.request.run_id !== journal.request.run_id
      || item.request_digest !== digestComposedJson("spawnfile.target-resource.request.v1", item.request)
      || item.operation_id !== digestComposedJson("simfile.composed-operation.v1", {
        command: item.command, request_digest: item.request_digest, sequence: item.sequence,
      }) || ((item.state === "completed") !== (item.target_receipt !== undefined))) {
      throw new TypeError("composed operation journal correlation is invalid");
    }
  }
  const bootstrapOperations = journal.bootstrap_operations ?? [];
  for (const [index, item] of bootstrapOperations.entries()) {
    assertSecretFreeComposedJson(item.request);
    if (item.sequence !== index || item.kind !== COMPOSED_BOOTSTRAP_OPERATION_KINDS[index]
      || (index < bootstrapOperations.length - 1 && item.state !== "completed")
      || item.request_digest !== digestComposedJson(
        "simfile.composed-bootstrap-operation-request.v1", { kind: item.kind, request: item.request },
      ) || item.operation_id !== digestComposedJson("simfile.composed-bootstrap-operation.v1", {
        kind: item.kind, request_digest: item.request_digest, sequence: item.sequence,
      }) || ((item.state === "completed") !== (item.receipt !== undefined))) {
      throw new TypeError("composed bootstrap operation correlation is invalid");
    }
  }
};

export const parseComposedPhaseJournal = (raw: unknown): ComposedPhaseJournal => {
  assertSecretFreeComposedJson(raw);
  const journal = composedPhaseJournalSchema.parse(raw);
  const bootstrap = journal.bootstrap === undefined
    ? undefined : parseComposedBootstrapCapsule(journal.bootstrap);
  const execution = journal.execution === undefined ? undefined : parseComposedExecution(journal.execution);
  const expectedAuthority = composedJournalAuthorityDigest({
    ...(bootstrap === undefined ? {} : { bootstrap }),
    ...(execution === undefined ? {} : { execution }), genesis_nonce: journal.genesis_nonce,
    recorded_at: journal.entries[0]!.recorded_at, request_digest: journal.request_digest,
  });
  if (journal.request_digest !== createComposedRunRequestDigest(journal.request)
    || journal.authority_digest !== expectedAuthority
    || journal.entries.length !== composedRunPhaseIndex(journal.current_phase) + 1
    || execution?.configuration.readiness_expectation.run_id !== undefined
      && execution.configuration.readiness_expectation.run_id !== journal.request.run_id
    || execution?.configuration.readiness_expectation.bundle_digest !== undefined
      && execution.configuration.readiness_expectation.bundle_digest !== journal.request.world.bundle_digest
    || execution?.configuration.organization_expectation.world_binding_digest !== undefined
      && execution.configuration.organization_expectation.world_binding_digest
        !== journal.request.organization.world_bindings_digest
    || journal.version === COMPOSED_PHASE_JOURNAL_VERSION
      && (bootstrap !== undefined || journal.bootstrap_binding !== undefined
        || journal.bootstrap_operations !== undefined)
    || journal.version === COMPOSED_PHASE_JOURNAL_BOOTSTRAP_VERSION
      && (bootstrap === undefined || bootstrap.run_id !== journal.request.run_id)) {
    throw new TypeError("composed journal correlation is invalid");
  }
  assertBinding(journal); assertEntries(journal); assertOperations(journal);
  if ((journal.state === "complete") !== (journal.current_phase === "completed")
    || (journal.state === "recoverable") !== (journal.interruption !== null)
    || journal.interruption !== null
      && journal.interruption.next_phase !== nextComposedRunPhase(journal.current_phase)) {
    throw new TypeError("composed journal state is contradictory");
  }
  const { journal_digest: _digest, ...body } = journal;
  if (journal.journal_digest !== digestComposedJson(journal.version, body)) {
    throw new TypeError("composed journal digest is invalid");
  }
  return Object.freeze(journal);
};

export const sealComposedPhaseJournal = (
  body: Omit<ComposedPhaseJournal, "journal_digest">,
): ComposedPhaseJournal => parseComposedPhaseJournal({
  ...body, journal_digest: digestComposedJson(body.version, body),
});
