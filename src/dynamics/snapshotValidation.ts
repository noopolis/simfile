import { canonicalDynamicsJson, cloneDynamicsJson, cloneDynamicsJsonObject } from "./canonicalJson.js";
import {
  digestDynamicsActionAttempt,
  dynamicsActionIdempotencyRecordCodeUnits,
  dynamicsActionKey
} from "./actionRetention.js";
import { DYNAMICS_ACTION_RETENTION_LIMITS, DYNAMICS_LIMITS } from "./limits.js";
import {
  DYNAMICS_SNAPSHOT_VERSION,
  type DynamicsActionIdempotencyRecord,
  type DynamicsActionIngressRecord,
  type DynamicsActionQueueReceipt,
  type DynamicsActionSequenceWatermark,
  type DynamicsQueuedAction,
  type DynamicsSessionSnapshot
} from "./types.js";
import { parseDynamicsActionAttempt, parseDynamicsProvenance } from "./validation.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const assertOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[], path: string): void => {
  const allowedSet = new Set(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedSet.has(key)) throw new Error(`${path} contains unknown field ${String(key)}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error(`${path}.${key} must be an enumerable data value`);
  }
};

const nonEmptyString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${path} must be a non-empty string`);
  cloneDynamicsJson(value, path);
  if (value.length > DYNAMICS_LIMITS.identifier_code_units) throw new Error(`${path} exceeds the dynamics identifier code-unit limit`);
  return value;
};

const integer = (value: unknown, path: string, minimum: number): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${path} must be a safe integer >= ${minimum}`);
  return Object.is(value, -0) ? 0 : value as number;
};

const positiveFinite = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${path} must be a positive finite number`);
  return value;
};

const isDenseArray = (value: unknown[]): boolean => {
  for (let index = 0; index < value.length; index += 1) if (!Object.hasOwn(value, index)) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return false;
  }
  return true;
};

const parseSequenceArray = (value: unknown, path: string, minimum: number): number[] => {
  if (!Array.isArray(value) || value.length > DYNAMICS_LIMITS.retained_action_records) throw new Error(`${path} exceeds the retained action limit`);
  if (!isDenseArray(value)) throw new Error(`${path} must not be sparse`);
  const sequences = value.map((entry, index) => integer(entry, `${path}[${index}]`, minimum));
  if (new Set(sequences).size !== sequences.length) throw new Error(`${path} must be unique`);
  return sequences.sort((left, right) => left - right);
};

const parseSequenceWatermark = (value: unknown, path: string): DynamicsActionSequenceWatermark => {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertOnlyKeys(value, ["above_floor", "floor"], path);
  const floor = integer(value.floor, `${path}.floor`, 1);
  const above = parseSequenceArray(value.above_floor, `${path}.above_floor`, floor + 1);
  if (above.some((sequence) => sequence <= floor)) throw new Error(`${path}.above_floor must be above floor`);
  return { floor, above_floor: above };
};

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

/** Canonical durable ingress order used by run records and compatibility projections. */
export const compareDynamicsIngressRecords = (left: DynamicsActionIngressRecord, right: DynamicsActionIngressRecord): number => {
  if (left.receipt.queued && right.receipt.queued) return (left.receipt.sequence as number) - (right.receipt.sequence as number);
  if (left.receipt.queued !== right.receipt.queued) return left.receipt.queued ? -1 : 1;
  return left.receipt.apply_tick - right.receipt.apply_tick || left.attempt.at_tick - right.attempt.at_tick
    || compareText(dynamicsActionKey(left.attempt), dynamicsActionKey(right.attempt));
};

/** Canonical serialized size for complete durable ingress evidence. */
export const dynamicsIngressRecordCodeUnits = (record: DynamicsActionIngressRecord): number =>
  canonicalDynamicsJson(record, "dynamics action ingress record").length;

const parseReceipt = (value: unknown, actId: string, atTick: number, path: string): DynamicsActionQueueReceipt => {
  if (!isRecord(value) || typeof value.queued !== "boolean") throw new Error(`${path} must declare queued as a boolean`);
  assertOnlyKeys(value, ["act_id", "apply_tick", "code", "queued", "sequence"], path);
  const receipt: DynamicsActionQueueReceipt = {
    act_id: nonEmptyString(value.act_id, `${path}.act_id`),
    apply_tick: integer(value.apply_tick, `${path}.apply_tick`, 0),
    queued: value.queued
  };
  if (receipt.act_id !== actId) throw new Error(`${path}.act_id must equal its retained identity`);
  if (receipt.queued) {
    if (value.code !== undefined) throw new Error(`${path} queued receipt cannot declare code`);
    receipt.sequence = integer(value.sequence, `${path}.sequence`, 1);
    if (receipt.apply_tick !== atTick) throw new Error(`${path}.apply_tick must equal the queued attempt tick`);
  } else {
    if (value.code !== "wrong_tick" || value.sequence !== undefined) throw new Error(`${path} stored rejection must be a sequence-free wrong_tick receipt`);
    if (receipt.apply_tick === atTick) throw new Error(`${path} wrong_tick receipt must disagree with the attempted tick`);
    receipt.code = "wrong_tick";
  }
  return receipt;
};

export const compareDynamicsActionIdempotencyRecords = (left: DynamicsActionIdempotencyRecord, right: DynamicsActionIdempotencyRecord): number => {
  if (left.receipt.queued && right.receipt.queued) return (left.receipt.sequence as number) - (right.receipt.sequence as number);
  if (left.receipt.queued !== right.receipt.queued) return left.receipt.queued ? -1 : 1;
  return left.retained_at_tick - right.retained_at_tick || left.receipt.apply_tick - right.receipt.apply_tick
    || left.at_tick - right.at_tick
    || compareText(dynamicsActionKey(left), dynamicsActionKey(right));
};

const parseIngress = (value: unknown): DynamicsActionIdempotencyRecord[] => {
  if (!Array.isArray(value) || value.length > DYNAMICS_ACTION_RETENTION_LIMITS.records) throw new Error("dynamics snapshot.action_ingress exceeds the retained ingress limit");
  if (!isDenseArray(value)) throw new Error("dynamics snapshot.action_ingress must not be sparse");
  const seen = new Set<string>();
  let retainedCodeUnits = 0;
  const records = value.map((entry, index) => {
    const path = `dynamics snapshot.action_ingress[${index}]`;
    if (!isRecord(entry)) throw new Error(`${path} must be an object`);
    assertOnlyKeys(entry, ["act_id", "at_tick", "attempt_sha256", "principal_id", "retained_at_tick", "receipt"], path);
    const record: DynamicsActionIdempotencyRecord = {
      act_id: nonEmptyString(entry.act_id, `${path}.act_id`),
      at_tick: integer(entry.at_tick, `${path}.at_tick`, 0),
      attempt_sha256: typeof entry.attempt_sha256 === "string" && SHA256_PATTERN.test(entry.attempt_sha256)
        ? entry.attempt_sha256 : (() => { throw new Error(`${path}.attempt_sha256 must be a SHA-256 digest`); })(),
      principal_id: nonEmptyString(entry.principal_id, `${path}.principal_id`),
      retained_at_tick: integer(entry.retained_at_tick, `${path}.retained_at_tick`, 0),
      receipt: {} as DynamicsActionQueueReceipt
    };
    record.receipt = parseReceipt(entry.receipt, record.act_id, record.at_tick, `${path}.receipt`);
    const key = dynamicsActionKey(record);
    if (seen.has(key)) throw new Error("dynamics snapshot.action_ingress keys must be unique");
    seen.add(key);
    retainedCodeUnits += dynamicsActionIdempotencyRecordCodeUnits(record);
    if (retainedCodeUnits > DYNAMICS_ACTION_RETENTION_LIMITS.code_units
      || retainedCodeUnits > DYNAMICS_LIMITS.retained_action_code_units) {
      throw new Error("dynamics snapshot.action_ingress exceeds the retained ingress code-unit limit");
    }
    return record;
  });
  return records.sort(compareDynamicsActionIdempotencyRecords);
};

const parsePending = (value: unknown): DynamicsQueuedAction[] => {
  if (!Array.isArray(value) || value.length > DYNAMICS_LIMITS.actions_per_tick) throw new Error("dynamics snapshot.pending_actions exceeds the pending action limit");
  if (!isDenseArray(value)) throw new Error("dynamics snapshot.pending_actions must not be sparse");
  const pending = value.map((entry, index) => {
    const path = `dynamics snapshot.pending_actions[${index}]`;
    const record = cloneDynamicsJsonObject(entry, path);
    const sequence = integer(record.sequence, `${path}.sequence`, 1);
    const { sequence: _ignored, ...attempt } = record;
    return { ...parseDynamicsActionAttempt(attempt), sequence };
  });
  if (new Set(pending.map((entry) => entry.sequence)).size !== pending.length) throw new Error("dynamics snapshot.pending action sequences must be unique");
  return pending.sort((left, right) => left.sequence - right.sequence);
};

const watermarkHas = (watermark: DynamicsActionSequenceWatermark, sequence: number): boolean =>
  sequence < watermark.floor || watermark.above_floor.includes(sequence);

const assertActionInvariants = (snapshot: {
  accepted: DynamicsActionSequenceWatermark;
  ingress: DynamicsActionIdempotencyRecord[];
  ingressFloor: number;
  nextActionSequence: number;
  nextTick: number;
  pending: DynamicsQueuedAction[];
  resolved: DynamicsActionSequenceWatermark;
}): void => {
  if (snapshot.ingressFloor > snapshot.nextActionSequence) throw new Error("dynamics snapshot retained sequence floor exceeds next_action_sequence");
  const queued = snapshot.ingress.filter((record) => record.receipt.queued);
  const queuedSequences = queued.map((record) => record.receipt.sequence as number);
  if (queuedSequences.length !== snapshot.nextActionSequence - snapshot.ingressFloor
    || queuedSequences.some((sequence, index) => sequence !== snapshot.ingressFloor + index)) {
    throw new Error("dynamics snapshot queued action sequences must be contiguous from the retained floor");
  }
  if (snapshot.pending.length !== queued.length
    || snapshot.pending.some((action, index) => action.sequence !== queuedSequences[index])) {
    throw new Error("dynamics snapshot pending actions must equal retained queued receipts");
  }
  const ingressByKey = new Map(snapshot.ingress.map((record) => [dynamicsActionKey(record), record]));
  for (const action of snapshot.pending) {
    if (action.at_tick !== snapshot.nextTick) throw new Error("dynamics snapshot pending actions must target next_tick");
    const retained = ingressByKey.get(dynamicsActionKey(action));
    if (!retained || retained.receipt.sequence !== action.sequence) throw new Error("dynamics snapshot pending action must correspond to its ingress receipt");
    const { sequence: _ignored, ...attempt } = action;
    if (digestDynamicsActionAttempt(attempt) !== retained.attempt_sha256) throw new Error("dynamics snapshot pending action digest differs from its ingress digest");
  }
  for (const record of snapshot.ingress) {
    if (record.retained_at_tick > snapshot.nextTick) {
      throw new Error("dynamics snapshot retained ingress cannot be from the future");
    }
    if (record.receipt.queued) {
      if (record.retained_at_tick !== snapshot.nextTick || record.receipt.apply_tick !== snapshot.nextTick) {
        throw new Error("dynamics snapshot queued ingress must belong to next_tick");
      }
    } else if (record.receipt.apply_tick < record.retained_at_tick || record.receipt.apply_tick > snapshot.nextTick) {
      throw new Error("dynamics snapshot rejected ingress receipt must belong to next_tick or its prior retry tick");
    }
  }
  if (snapshot.resolved.floor !== snapshot.ingressFloor || snapshot.resolved.above_floor.length !== 0) {
    throw new Error("dynamics snapshot resolved sequence watermark must reach the retained floor without exceptions");
  }
  if (snapshot.accepted.floor > snapshot.resolved.floor) throw new Error("dynamics snapshot accepted sequence floor exceeds the resolved floor");
  for (const sequence of snapshot.accepted.above_floor) {
    if (!watermarkHas(snapshot.resolved, sequence)) throw new Error("dynamics snapshot accepted sequence is not resolved");
  }
};

export const parseDynamicsSessionSnapshot = (value: unknown): DynamicsSessionSnapshot => {
  if (!isRecord(value) || value.version !== DYNAMICS_SNAPSHOT_VERSION) throw new Error("invalid simfile dynamics snapshot version");
  assertOnlyKeys(value, [
    "accepted_action_sequences", "action_ingress", "action_ingress_floor", "action_ingress_ordinal",
    "next_action_sequence", "next_event_sequence", "next_tick", "pending_actions", "provider_state",
    "provenance", "resolved_action_sequences", "seed", "sim_seconds_per_tick", "version"
  ], "dynamics snapshot");
  const snapshot = {
    accepted: parseSequenceWatermark(value.accepted_action_sequences, "dynamics snapshot.accepted_action_sequences"),
    ingress: parseIngress(value.action_ingress),
    ingressFloor: integer(value.action_ingress_floor, "dynamics snapshot.action_ingress_floor", 1),
    ingressOrdinal: integer(value.action_ingress_ordinal, "dynamics snapshot.action_ingress_ordinal", 0),
    nextActionSequence: integer(value.next_action_sequence, "dynamics snapshot.next_action_sequence", 1),
    nextEventSequence: integer(value.next_event_sequence, "dynamics snapshot.next_event_sequence", 1),
    nextTick: integer(value.next_tick, "dynamics snapshot.next_tick", 0),
    pending: parsePending(value.pending_actions),
    resolved: parseSequenceWatermark(value.resolved_action_sequences, "dynamics snapshot.resolved_action_sequences")
  };
  assertActionInvariants(snapshot);
  return {
    accepted_action_sequences: snapshot.accepted,
    action_ingress: snapshot.ingress,
    action_ingress_floor: snapshot.ingressFloor,
    action_ingress_ordinal: snapshot.ingressOrdinal,
    next_action_sequence: snapshot.nextActionSequence,
    next_event_sequence: snapshot.nextEventSequence,
    next_tick: snapshot.nextTick,
    pending_actions: snapshot.pending,
    provider_state: cloneDynamicsJson(value.provider_state, "dynamics snapshot.provider_state"),
    provenance: parseDynamicsProvenance(value.provenance),
    resolved_action_sequences: snapshot.resolved,
    seed: cloneDynamicsJson(nonEmptyString(value.seed, "dynamics snapshot.seed"), "dynamics snapshot.seed") as string,
    sim_seconds_per_tick: positiveFinite(value.sim_seconds_per_tick, "dynamics snapshot.sim_seconds_per_tick"),
    version: DYNAMICS_SNAPSHOT_VERSION
  };
};
