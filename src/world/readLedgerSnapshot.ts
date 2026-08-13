import { types } from "node:util";

import { DYNAMICS_LIMITS } from "../dynamics/limits.js";
import { parseWorldReadLedgerRecord, type WorldReadLedgerRecord } from "./ledger.js";

export const WORLD_READ_LEDGER_SNAPSHOT_VERSION = "simfile.world-read-ledger.v1" as const;
export interface WorldReadLedgerSnapshotLane { readonly principal: string; readonly last_sequence: number; readonly evicted_through: number; readonly records: readonly WorldReadLedgerRecord[]; }
export interface WorldReadLedgerSnapshot { readonly version: typeof WORLD_READ_LEDGER_SNAPSHOT_VERSION; readonly max_entries_per_principal: number; readonly max_principals: number; readonly lanes: readonly WorldReadLedgerSnapshotLane[]; }

const MAX_TEXT = 256;
const binding = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT && value === value.trim();
const integer = (value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const frozen = <T>(value: T): T => Object.freeze(value);
const proxy = (value: object): boolean => types.isProxy(value);
const dangerous = new Set(["__proto__", "constructor", "prototype"]);
const index = /^(?:0|[1-9][0-9]*)$/u;
/* Establish graph identity without running caller code; individual records are
 * parsed separately so a legal retained history is not one generic JSON blob. */
const scan = (value: unknown, seen: Set<object>, depth = 0): void => {
  if (depth > 24 || value === null || typeof value !== "object") return;
  if (proxy(value as object) || seen.has(value as object)) throw new TypeError("hostile read ledger snapshot");
  seen.add(value as object); const array = Array.isArray(value); const prototype = Object.getPrototypeOf(value);
  if ((array && prototype !== Array.prototype) || (!array && prototype !== Object.prototype && prototype !== null)) throw new TypeError("hostile read ledger snapshot");
  for (let current: object | null = value as object; current !== null; current = Object.getPrototypeOf(current)) if (proxy(current) || Object.getOwnPropertyDescriptor(current, "then") !== undefined) throw new TypeError("hostile read ledger snapshot");
  const keys = Reflect.ownKeys(value);
  if (array) { const length = Object.getOwnPropertyDescriptor(value, "length"); if (!length || !("value" in length) || !integer(length.value, 0, DYNAMICS_LIMITS.retained_action_records) || keys.length !== length.value + 1 || keys.some((key) => typeof key !== "string" || (key !== "length" && (!index.test(key) || Number(key) >= length.value)))) throw new TypeError("hostile read ledger snapshot"); for (let offset = 0; offset < length.value; offset += 1) { const descriptor = Object.getOwnPropertyDescriptor(value, String(offset)); if (!descriptor?.enumerable || !("value" in descriptor)) throw new TypeError("hostile read ledger snapshot"); scan(descriptor.value, seen, depth + 1); } return; }
  for (const key of keys) { if (typeof key !== "string" || dangerous.has(key)) throw new TypeError("hostile read ledger snapshot"); const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor?.enumerable || !("value" in descriptor)) throw new TypeError("hostile read ledger snapshot"); scan(descriptor.value, seen, depth + 1); }
};

const fields = (value: unknown, expected: readonly string[], nullPrototype = false): Record<string, unknown> | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || proxy(value as object)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && (!nullPrototype || prototype !== null)) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || keys.some((key) => typeof key !== "string" || dangerous.has(key) || !expected.includes(key))) return undefined;
  const result: Record<string, unknown> = Object.create(null);
  for (const key of expected) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor?.enumerable || !("value" in descriptor)) return undefined; result[key] = descriptor.value; }
  return result;
};
/** Descriptor-only scan. Its limit is checked before looking at index zero. */
const values = (value: unknown, limit: number): readonly unknown[] | undefined => {
  if (!Array.isArray(value) || proxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (!length || !("value" in length) || !integer(length.value, 0, limit)) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length.value + 1 || keys.some((key) => typeof key !== "string" || (key !== "length" && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length.value)))) return undefined;
  const result: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) { const descriptor = Object.getOwnPropertyDescriptor(value, String(index)); if (!descriptor?.enumerable || !("value" in descriptor)) return undefined; result.push(descriptor.value); }
  return result;
};
const clone = (record: WorldReadLedgerRecord): WorldReadLedgerRecord => frozen({ ...record, ...(record.identity === undefined ? {} : { identity: frozen({ ...record.identity }) }) });
const parseRecord = (value: unknown, principal: string, sequence: number): WorldReadLedgerRecord | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || proxy(value as object)) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return undefined;
  const source = fields(value, keys as string[], true);
  if (source === undefined || source.sequence !== sequence || source.principal !== principal) return undefined;
  const { sequence: ignored, ...rest } = source;
  const record = parseWorldReadLedgerRecord(rest);
  return record === undefined ? undefined : clone({ ...record, sequence });
};
const parseLane = (value: unknown, capacity: number): WorldReadLedgerSnapshotLane | undefined => {
  const source = fields(value, ["principal", "last_sequence", "evicted_through", "records"]);
  if (source === undefined || !binding(source.principal) || !integer(source.last_sequence, 0) || !integer(source.evicted_through, 0, source.last_sequence)) return undefined;
  const rawRecords = values(source.records, capacity);
  if (rawRecords === undefined || rawRecords.length !== source.last_sequence - source.evicted_through) return undefined;
  const records: WorldReadLedgerRecord[] = [];
  for (let index = 0; index < rawRecords.length; index += 1) { const record = parseRecord(rawRecords[index], source.principal, source.evicted_through + index + 1); if (record === undefined) return undefined; records.push(record); }
  return frozen({ principal: source.principal, last_sequence: source.last_sequence, evicted_through: source.evicted_through, records: frozen(records) });
};
const parse = (input: unknown): WorldReadLedgerSnapshot | undefined => {
  scan(input, new Set<object>());
  const source = fields(input, ["version", "max_entries_per_principal", "max_principals", "lanes"]);
  if (source === undefined || source.version !== WORLD_READ_LEDGER_SNAPSHOT_VERSION || !integer(source.max_entries_per_principal, 1, DYNAMICS_LIMITS.retained_action_records) || !integer(source.max_principals, 1, 4096)) return undefined;
  const rawLanes = values(source.lanes, source.max_principals);
  if (rawLanes === undefined) return undefined;
  const lanes: WorldReadLedgerSnapshotLane[] = [];
  for (const rawLane of rawLanes) { const lane = parseLane(rawLane, source.max_entries_per_principal); if (lane === undefined || lanes.some((known) => known.principal === lane.principal)) return undefined; lanes.push(lane); }
  lanes.sort((left, right) => left.principal < right.principal ? -1 : left.principal > right.principal ? 1 : 0);
  return frozen({ version: WORLD_READ_LEDGER_SNAPSHOT_VERSION, max_entries_per_principal: source.max_entries_per_principal, max_principals: source.max_principals, lanes: frozen(lanes) });
};
export const parseWorldReadLedgerSnapshot = (input: unknown): WorldReadLedgerSnapshot | undefined => { try { return parse(input); } catch { return undefined; } };
export const cloneWorldReadLedgerSnapshot = (input: WorldReadLedgerSnapshot): WorldReadLedgerSnapshot => { const parsed = parseWorldReadLedgerSnapshot(input); if (parsed === undefined) throw new TypeError("invalid world read ledger snapshot"); return parsed; };
