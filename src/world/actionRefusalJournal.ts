import { DYNAMICS_ACTION_RETENTION_LIMITS } from "../dynamics/limits.js";
import {
  isWorldActIngressRejectionFieldPath,
  isWorldActIngressRejectionReason,
  type WorldActIngressRejectionReason,
} from "../world-surface/index.js";
import type { WorldActIngressRejection } from "./actTypes.js";

export interface WorldActionRefusal {
  readonly at_tick: number;
  readonly principal?: string;
  readonly reason: WorldActIngressRejectionReason;
  readonly field_path?: string;
}

export interface WorldActionRefusalEvidence {
  readonly ordinal: number;
  readonly refusal: WorldActionRefusal;
}

export interface WorldActionRefusalReadPort {
  read(afterOrdinal: number): readonly WorldActionRefusalEvidence[];
  acknowledge(ordinal: number): void;
}

export interface WorldActionRefusalJournal extends WorldActionRefusalReadPort {
  refuse(
    principal: unknown,
    reason: unknown,
    fieldPath?: unknown,
  ): WorldActIngressRejection;
}

export interface CreateWorldActionRefusalJournalOptions {
  readonly capacity?: number;
  readonly principals: readonly string[];
  readonly readTick: () => number;
}

const issued = new WeakSet<object>();
const frozen = <Value>(value: Value): Value => Object.freeze(value);
const ordinal = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const cloneRefusal = (value: WorldActionRefusal): WorldActionRefusal => frozen({
  at_tick: value.at_tick,
  ...(value.principal === undefined ? {} : { principal: value.principal }),
  reason: value.reason,
  ...(value.field_path === undefined ? {} : { field_path: value.field_path }),
});
const cloneEvidence = (
  value: WorldActionRefusalEvidence,
): WorldActionRefusalEvidence => frozen({
  ordinal: value.ordinal,
  refusal: cloneRefusal(value.refusal),
});

export const readWorldActionRefusalJournal = (
  value: unknown,
): WorldActionRefusalJournal | undefined =>
  value !== null && typeof value === "object" && issued.has(value)
    ? value as WorldActionRefusalJournal
    : undefined;

/**
 * Host-only refusal evidence. Retention is bounded; if undrained entries are
 * overwritten, read() throws for every cursor behind the lost ordinal instead
 * of returning a silently incomplete stream.
 */
export const createWorldActionRefusalJournal = (
  options: CreateWorldActionRefusalJournalOptions,
): WorldActionRefusalJournal => {
  const capacity = options.capacity ?? DYNAMICS_ACTION_RETENTION_LIMITS.records;
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new Error("world action refusal journal capacity must be positive");
  }
  const initialTick = options.readTick();
  if (!ordinal(initialTick)) {
    throw new Error("world action refusal journal requires an initial host tick");
  }
  const principals = new Set(options.principals);
  let entries: WorldActionRefusalEvidence[] = [];
  let currentOrdinal = 0;
  let lastTick = initialTick;
  let lostThrough = 0;
  let unordinaledLoss = false;

  const journal: WorldActionRefusalJournal = frozen({
    acknowledge: (throughOrdinal: number): void => {
      if (!ordinal(throughOrdinal) || throughOrdinal > currentOrdinal) {
        throw new Error(
          "world action refusal acknowledgment is outside the issued range",
        );
      }
      entries = entries.filter((entry) => entry.ordinal > throughOrdinal);
    },
    read: (afterOrdinal: number): readonly WorldActionRefusalEvidence[] => {
      if (!ordinal(afterOrdinal)) {
        throw new Error(
          "world action refusal ordinal must be a non-negative safe integer",
        );
      }
      if (unordinaledLoss) {
        throw new Error(
          `world action refusal evidence loss after ordinal ${currentOrdinal}`,
        );
      }
      if (afterOrdinal < lostThrough) {
        throw new Error(
          `world action refusal evidence overflow through ordinal ${lostThrough}`,
        );
      }
      return frozen(entries
        .filter((entry) => entry.ordinal > afterOrdinal)
        .map(cloneEvidence));
    },
    refuse: (
      principal: unknown,
      reason: unknown,
      fieldPath?: unknown,
    ): WorldActIngressRejection => {
      const bounded = isWorldActIngressRejectionReason(reason)
        && (fieldPath === undefined
          || isWorldActIngressRejectionFieldPath(fieldPath));
      const safeReason: WorldActIngressRejectionReason = bounded
        ? reason
        : "internal_error";
      const safeFieldPath = bounded ? fieldPath as string | undefined : undefined;
      const receipt: WorldActIngressRejection = frozen({
        disposition: "rejected_at_ingress",
        code: "world_action_denied",
        reason: safeReason,
        ...(safeFieldPath === undefined ? {} : { field_path: safeFieldPath }),
      });
      try {
        const observedTick = options.readTick();
        if (ordinal(observedTick)) lastTick = observedTick;
      } catch { /* retain the last real host tick */ }
      if (currentOrdinal >= Number.MAX_SAFE_INTEGER) {
        unordinaledLoss = true;
        return receipt;
      }
      const attemptedOrdinal = currentOrdinal + 1;
      try {
        const refusal = cloneRefusal({
          at_tick: lastTick,
          ...(typeof principal === "string" && principals.has(principal)
            ? { principal }
            : {}),
          reason: safeReason,
          ...(safeFieldPath === undefined ? {} : { field_path: safeFieldPath }),
        });
        currentOrdinal = attemptedOrdinal;
        entries.push(frozen({ ordinal: attemptedOrdinal, refusal }));
        if (entries.length > capacity) {
          const lost = entries.shift();
          if (lost === undefined) {
            lostThrough = Math.max(lostThrough, attemptedOrdinal);
          } else {
            lostThrough = Math.max(lostThrough, lost.ordinal);
          }
        }
      } catch {
        currentOrdinal = Math.max(currentOrdinal, attemptedOrdinal);
        lostThrough = Math.max(lostThrough, attemptedOrdinal);
      }
      return receipt;
    },
  });
  issued.add(journal);
  return journal;
};
