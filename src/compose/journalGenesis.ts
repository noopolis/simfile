import { randomBytes } from "node:crypto";

import { parseComposedBootstrapCapsule } from "./bootstrapAuthority.js";
import { parseComposedExecution } from "./execution.js";
import {
  COMPOSED_PHASE_JOURNAL_BOOTSTRAP_VERSION,
  COMPOSED_PHASE_JOURNAL_VERSION,
  journalTimestampSchema,
  type ComposedPhaseJournal,
} from "./journalSchema.js";
import {
  composedJournalAuthorityDigest,
  composedPhasePayloadDigest,
  sealComposedPhaseJournal,
} from "./journalValidation.js";
import {
  createComposedRunRequestDigest,
  parseComposedRunRequest,
} from "./request.js";
import { composedRunPhaseIndex, type ComposedRunPhase } from "./types.js";

const phaseEntry = (phase: ComposedRunPhase, value: Record<string, unknown>, recordedAt: string) => ({
  payload: value,
  payload_digest: composedPhasePayloadDigest(phase, value),
  phase,
  recorded_at: journalTimestampSchema.parse(recordedAt),
  sequence: composedRunPhaseIndex(phase),
});

export const createComposedPhaseJournal = (
  rawRequest: unknown,
  recordedAt: string,
  rawExecution?: unknown,
): ComposedPhaseJournal => {
  const request = parseComposedRunRequest(rawRequest);
  const execution = rawExecution === undefined ? undefined : parseComposedExecution(rawExecution);
  const requestDigest = createComposedRunRequestDigest(request);
  const initial = phaseEntry("requested", { request_digest: requestDigest,
    run_id: request.run_id }, recordedAt);
  const genesisNonce = randomBytes(32).toString("hex");
  return sealComposedPhaseJournal({
    authority_digest: composedJournalAuthorityDigest({
      ...(execution === undefined ? {} : { execution }), genesis_nonce: genesisNonce,
      recorded_at: initial.recorded_at, request_digest: requestDigest,
    }),
    current_phase: "requested", entries: [initial],
    ...(execution === undefined ? {} : { execution }), genesis_nonce: genesisNonce,
    interruption: null, operations: [], request, request_digest: requestDigest,
    state: "active", version: COMPOSED_PHASE_JOURNAL_VERSION,
  });
};

/** Creates and seals the pre-target authority before any provider/auth mutation. */
export const createBootstrapComposedPhaseJournal = (
  rawRequest: unknown,
  rawBootstrap: unknown,
  recordedAt: string,
): ComposedPhaseJournal => {
  const request = parseComposedRunRequest(rawRequest);
  const bootstrap = parseComposedBootstrapCapsule(rawBootstrap);
  if (bootstrap.run_id !== request.run_id) {
    throw new TypeError("composed bootstrap run correlation is invalid");
  }
  const requestDigest = createComposedRunRequestDigest(request);
  const initial = phaseEntry("requested", { request_digest: requestDigest,
    run_id: request.run_id }, recordedAt);
  const genesisNonce = randomBytes(32).toString("hex");
  return sealComposedPhaseJournal({
    authority_digest: composedJournalAuthorityDigest({ bootstrap,
      genesis_nonce: genesisNonce, recorded_at: initial.recorded_at,
      request_digest: requestDigest }),
    bootstrap, bootstrap_operations: [], current_phase: "requested", entries: [initial],
    genesis_nonce: genesisNonce, interruption: null, operations: [], request,
    request_digest: requestDigest, state: "active",
    version: COMPOSED_PHASE_JOURNAL_BOOTSTRAP_VERSION,
  });
};
