import { types } from "node:util";

import { canonicalDynamicsJson } from "../dynamics/canonicalJson.js";
import { DYNAMICS_LIMITS } from "../dynamics/limits.js";
import type { QueuedWorldAction, WorldActQueuedReceipt } from "./actTypes.js";
import { parseWorldActEnvelope } from "./actEnvelope.js";
import { copyHostileJson, type HostileJson } from "./hostileJson.js";
import { parseQueuedWorldAction, parseWorldActionReceipt } from "./actionJournalSnapshot.js";

export const WORLD_REQUEST_LEDGER_SNAPSHOT_VERSION = "simfile.world-request-ledger.v1" as const;

export interface WorldRequestAuthority {
  readonly principal: string;
  readonly run_id: string;
  readonly world_id: string;
  readonly world_instance_id: string;
}

export interface WorldRequestLedgerSnapshotRecord {
  readonly request_id: string;
  readonly authority: WorldRequestAuthority;
  readonly request_bytes: readonly number[];
  readonly at_tick: number;
  readonly queued_action: QueuedWorldAction;
  readonly receipt: WorldActQueuedReceipt;
}

export interface WorldRequestLedgerSnapshot {
  readonly version: typeof WORLD_REQUEST_LEDGER_SNAPSHOT_VERSION;
  readonly closed: boolean;
  readonly record_count: number;
  readonly code_units: number;
  readonly records: readonly WorldRequestLedgerSnapshotRecord[];
}

type JsonRecord = Readonly<Record<string, HostileJson>>;
const binding = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= DYNAMICS_LIMITS.identifier_code_units && value === value.trim();
const tick = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const fail = (): undefined => undefined;
const frozen = <Value>(value: Value): Value => Object.freeze(value);
const compareUtf16 = (left: string, right: string): number => left === right ? 0 : left < right ? -1 : 1;
const readFields = (value: unknown, expected: readonly string[], allowNullPrototype = false): JsonRecord | undefined => {
  if (types.isProxy(value) || value === null || typeof value !== "object" ||
    Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype &&
      (!allowNullPrototype || Object.getPrototypeOf(value) !== null))) return fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || keys.some((key) => typeof key !== "string" || !expected.includes(key))) return fail();
  const result: Record<string, HostileJson> = {};
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return fail();
    result[key] = descriptor.value as HostileJson;
  }
  return result;
};
const readArray = (value: unknown): readonly unknown[] | undefined => {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return fail();
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
    lengthDescriptor.value > DYNAMICS_LIMITS.retained_action_records) return fail();
  const length = lengthDescriptor.value;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes("length") || keys.some((key) =>
    typeof key !== "string" || (key !== "length" && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length)))) return fail();
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return fail();
    result.push(descriptor.value);
  }
  return result;
};
const array = (value: HostileJson): readonly HostileJson[] | undefined => Array.isArray(value) ? value : fail();
const equalBytes = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);
const equalAuthority = (left: WorldRequestAuthority, right: WorldRequestAuthority): boolean =>
  left.principal === right.principal && left.run_id === right.run_id && left.world_id === right.world_id
  && left.world_instance_id === right.world_instance_id;

const parseAuthority = (value: HostileJson): WorldRequestAuthority | undefined => {
  const source = readFields(value, ["principal", "run_id", "world_id", "world_instance_id"], true);
  if (source === undefined || !binding(source.principal) || !binding(source.run_id)
    || !binding(source.world_id) || !binding(source.world_instance_id)) return fail();
  return frozen({ principal: source.principal, run_id: source.run_id, world_id: source.world_id, world_instance_id: source.world_instance_id });
};

const parseBytes = (value: HostileJson): readonly number[] | undefined => {
  const values = array(value);
  if (values === undefined || values.length === 0 || values.length > DYNAMICS_LIMITS.retained_action_code_units) return fail();
  const bytes: number[] = [];
  for (const byte of values) {
    if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) return fail();
    bytes.push(byte);
  }
  return frozen(bytes);
};

const sequenceOf = (receiptId: unknown): number | undefined => {
  if (typeof receiptId !== "string") return undefined;
  const match = /^world-act-([1-9][0-9]*)$/u.exec(receiptId);
  if (match === null) return undefined;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) && sequence >= 1 ? sequence : undefined;
};

const recordCodeUnits = (record: WorldRequestLedgerSnapshotRecord): number => canonicalDynamicsJson({
  request_id: record.request_id,
  authority: record.authority,
  request_bytes: record.request_bytes,
  at_tick: record.at_tick,
  queued_action: record.queued_action,
  receipt: record.receipt,
}).length;

const parseRecord = (value: HostileJson): WorldRequestLedgerSnapshotRecord | undefined => {
  const source = readFields(value, ["request_id", "authority", "request_bytes", "at_tick", "queued_action", "receipt"], true);
  if (source === undefined || !binding(source.request_id) || !tick(source.at_tick)) return fail();
  const authority = parseAuthority(source.authority);
  const requestBytes = parseBytes(source.request_bytes);
  if (authority === undefined || requestBytes === undefined) return fail();
  let envelope: ReturnType<typeof parseWorldActEnvelope>;
  try { envelope = parseWorldActEnvelope(Uint8Array.from(requestBytes)); } catch { return fail(); }
  if (envelope.request_id !== source.request_id) return fail();
  const sequence = sequenceOf((source.receipt as JsonRecord | undefined)?.receipt_id);
  if (sequence === undefined) return fail();
  const receipt = parseWorldActionReceipt(source.receipt, sequence);
  const queued = receipt === undefined ? undefined : parseQueuedWorldAction(source.queued_action, receipt, sequence);
  if (receipt === undefined || queued === undefined || queued.principal !== authority.principal
    || queued.affordance !== envelope.affordance || queued.target !== envelope.target
    || queued.at_tick !== source.at_tick || receipt.apply_tick !== source.at_tick
    || receipt.identity.run_id !== authority.run_id || receipt.identity.world_id !== authority.world_id
    || receipt.identity.world_instance_id !== authority.world_instance_id) return fail();
  const record: WorldRequestLedgerSnapshotRecord = frozen({
    request_id: source.request_id,
    authority,
    request_bytes: requestBytes,
    at_tick: source.at_tick,
    queued_action: queued,
    receipt,
  });
  return recordCodeUnits(record) <= DYNAMICS_LIMITS.retained_action_code_units ? record : fail();
};

const parse = (input: unknown): WorldRequestLedgerSnapshot | undefined => {
  const source = readFields(input, ["version", "closed", "record_count", "code_units", "records"]);
  const values = source === undefined ? undefined : readArray(source.records);
  if (source === undefined || source.version !== WORLD_REQUEST_LEDGER_SNAPSHOT_VERSION || typeof source.closed !== "boolean"
    || values === undefined || values.length > DYNAMICS_LIMITS.retained_action_records
    || typeof source.record_count !== "number" || !Number.isSafeInteger(source.record_count)
    || source.record_count < 0 || source.record_count > DYNAMICS_LIMITS.retained_action_records
    || source.record_count !== values.length || typeof source.code_units !== "number"
    || !Number.isSafeInteger(source.code_units) || source.code_units < 0
    || source.code_units > DYNAMICS_LIMITS.retained_action_code_units) return fail();
  const records: WorldRequestLedgerSnapshotRecord[] = [];
  const ids = new Set<string>();
  for (const value of values) {
    let record: WorldRequestLedgerSnapshotRecord | undefined;
    try { record = parseRecord(copyHostileJson(value)); } catch { return fail(); }
    if (record === undefined || ids.has(record.request_id)) return fail();
    ids.add(record.request_id); records.push(record);
  }
  for (let index = 1; index < records.length; index += 1) {
    if (compareUtf16(records[index - 1]!.request_id, records[index]!.request_id) >= 0) return fail();
  }
  const codeUnits = records.reduce((total, record) => total + recordCodeUnits(record), 0);
  if (codeUnits !== source.code_units) return fail();
  return frozen({ version: WORLD_REQUEST_LEDGER_SNAPSHOT_VERSION, closed: source.closed,
    record_count: records.length, code_units: codeUnits, records: frozen(records) });
};

export const parseWorldRequestLedgerSnapshot = (input: unknown): WorldRequestLedgerSnapshot | undefined => {
  try { return parse(input); } catch { return undefined; }
};

export const cloneWorldRequestLedgerSnapshot = (input: WorldRequestLedgerSnapshot): WorldRequestLedgerSnapshot => {
  const parsed = parseWorldRequestLedgerSnapshot(input);
  if (parsed === undefined) throw new TypeError("invalid world request ledger snapshot");
  return parsed;
};

export const sameWorldRequestAuthority = equalAuthority;
export const worldRequestLedgerRecordCodeUnits = recordCodeUnits;
export const sameWorldRequestBytes = equalBytes;
