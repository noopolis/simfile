import { createHash } from "node:crypto";

import { canonicalDynamicsJson } from "./canonicalJson.js";
import { DYNAMICS_ACTION_RETENTION_LIMITS } from "./limits.js";
import { issueDynamicsRetainedActionCapacityError } from "./retainedCapacity.js";
import { cloneAttempt, cloneReceipt } from "./sessionValues.js";
import type {
  DynamicsActionAttempt,
  DynamicsActionIdempotencyRecord,
  DynamicsActionIngressEvidence,
  DynamicsActionIngressRecord,
  DynamicsActionQueueReceipt,
  ReadonlyDynamicsJsonObject
} from "./types.js";

export const dynamicsActionKey = (
  value: Pick<DynamicsActionAttempt, "act_id" | "principal_id">
): string => canonicalDynamicsJson([value.principal_id, value.act_id]);

export const digestDynamicsActionAttempt = (
  attempt: Omit<DynamicsActionAttempt, "input"> & {
    readonly input: ReadonlyDynamicsJsonObject;
  }
): string => createHash("sha256")
  .update(canonicalDynamicsJson(attempt, "dynamics action attempt"))
  .digest("hex");

export const createDynamicsActionIdempotencyRecord = (
  attempt: DynamicsActionAttempt,
  receipt: DynamicsActionQueueReceipt
): DynamicsActionIdempotencyRecord => ({
  act_id: attempt.act_id,
  at_tick: attempt.at_tick,
  attempt_sha256: digestDynamicsActionAttempt(attempt),
  principal_id: attempt.principal_id,
  retained_at_tick: receipt.apply_tick,
  receipt: cloneReceipt(receipt)
});

export const cloneDynamicsActionIdempotencyRecord = (
  record: DynamicsActionIdempotencyRecord
): DynamicsActionIdempotencyRecord => ({
  ...record,
  receipt: cloneReceipt(record.receipt)
});

export const cloneDynamicsActionIngressEvidence = (
  evidence: DynamicsActionIngressEvidence
): DynamicsActionIngressEvidence => ({
  ordinal: evidence.ordinal,
  record: {
    attempt: cloneAttempt(evidence.record.attempt),
    receipt: cloneReceipt(evidence.record.receipt)
  }
});

export const dynamicsActionIdempotencyRecordCodeUnits = (
  record: DynamicsActionIdempotencyRecord
): number => canonicalDynamicsJson(
  record,
  "dynamics action idempotency record"
).length;

export const sameDynamicsActionAttempt = (
  record: DynamicsActionIdempotencyRecord,
  attempt: DynamicsActionAttempt
): boolean => record.attempt_sha256 === digestDynamicsActionAttempt(attempt);

export interface DynamicsActionIngressEvidenceBuffer {
  readonly ordinal: number;
  acknowledge(throughOrdinal: number): void;
  assertAvailable(): void;
  emit(attempt: DynamicsActionAttempt, receipt: DynamicsActionQueueReceipt): void;
  read(afterOrdinal: number): readonly DynamicsActionIngressEvidence[];
  restore(ordinal: number): void;
}

export const createDynamicsActionIngressEvidenceBuffer = (): DynamicsActionIngressEvidenceBuffer => {
  let entries: DynamicsActionIngressEvidence[] = [];
  let ordinal = 0;
  let nextOrdinal = 1;
  const assertAvailable = (): void => {
    if (entries.length >= DYNAMICS_ACTION_RETENTION_LIMITS.records) {
      throw issueDynamicsRetainedActionCapacityError("records");
    }
    if (nextOrdinal >= Number.MAX_SAFE_INTEGER) {
      throw issueDynamicsRetainedActionCapacityError("sequence");
    }
  };
  return {
    get ordinal() { return ordinal; },
    acknowledge: (throughOrdinal): void => {
      if (!Number.isSafeInteger(throughOrdinal) || throughOrdinal < 0 || throughOrdinal > ordinal) {
        throw new Error("dynamics ingress evidence acknowledgment is outside the issued range");
      }
      entries = entries.filter((entry) => entry.ordinal > throughOrdinal);
    },
    assertAvailable,
    emit: (attempt, receipt): void => {
      const issued = nextOrdinal++;
      ordinal = issued;
      entries.push({ ordinal: issued, record: {
        attempt: cloneAttempt(attempt), receipt: cloneReceipt(receipt)
      } });
    },
    read: (afterOrdinal): readonly DynamicsActionIngressEvidence[] => {
      if (!Number.isSafeInteger(afterOrdinal) || afterOrdinal < 0) {
        throw new Error("dynamics ingress evidence ordinal must be a non-negative safe integer");
      }
      return entries.filter((entry) => entry.ordinal > afterOrdinal)
        .map(cloneDynamicsActionIngressEvidence);
    },
    restore: (restoredOrdinal): void => {
      entries = entries.filter((entry) => entry.ordinal <= restoredOrdinal);
      ordinal = restoredOrdinal;
      nextOrdinal = restoredOrdinal + 1;
    }
  };
};
