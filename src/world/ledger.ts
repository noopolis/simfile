import { types } from "node:util";
import { cloneWorldReadLedgerSnapshot, parseWorldReadLedgerSnapshot, type WorldReadLedgerSnapshot } from "./readLedgerSnapshot.js";

export const WORLD_READ_OPERATIONS = ["status", "capabilities", "observe", "affordances", "ledger"] as const;
export type WorldReadOperation = typeof WORLD_READ_OPERATIONS[number];
export type WorldRuntimeErrorCode = "world_runtime_denied" | "world_runtime_invalid_composition";

const MESSAGES: Record<WorldRuntimeErrorCode, string> = {
  world_runtime_denied: "World runtime request denied.",
  world_runtime_invalid_composition: "World runtime construction failed.",
};

/** Public, deliberately non-diagnostic failure surface for the B21 boundary. */
export class WorldRuntimeError extends Error {
  public readonly code: WorldRuntimeErrorCode;
  public constructor(code: WorldRuntimeErrorCode) {
    super(MESSAGES[code]); this.name = "WorldRuntimeError"; this.code = code;
  }
}

export interface WorldReadIdentity {
  readonly run_id: string; readonly world_id: string; readonly world_instance_id: string;
  readonly manifest_digest: string; readonly state_version: number;
}
export interface WorldReadLedgerRecord {
  readonly sequence: number; readonly operation: WorldReadOperation; readonly principal: string;
  readonly decision_id?: string; readonly state_version?: number; readonly result: "allowed" | "denied";
  readonly identity?: WorldReadIdentity;
}
export interface WorldReadLedgerPage { readonly records: readonly WorldReadLedgerRecord[]; readonly next_after: number; }
interface WorldReadLedgerAppend extends Omit<WorldReadLedgerRecord, "sequence"> {}
export interface WorldReadLedger { read(principal: string, request: unknown): WorldReadLedgerPage; }
export interface WorldReadLedgerAuthority {
  append(input: WorldReadLedgerAppend): void;
  read(principal: string, request: unknown): WorldReadLedgerPage;
  reservePrincipals(principals: unknown): void;
  /** @internal Host-only checkpoint seam; never present on the public handle. */
  snapshot(): WorldReadLedgerSnapshot;
  /** @internal Host-only checkpoint seam; pristine targets only. */
  restore(input: unknown): void;
}
export interface WorldReadLedgerOptions { readonly maxEntriesPerPrincipal?: number; readonly maxPrincipals?: number; }

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DEFAULT_RETAINED_ENTRIES = 256;
const DEFAULT_PRINCIPALS = 256;
const MAX_RETAINED_ENTRIES = 10_000;
const MAX_PRINCIPALS = 4_096;
const MAX_TEXT = 256;
const DECISION_ID = /^decision-[0-9]{12}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const issuedLedgers = new WeakMap<object, WorldReadLedgerAuthority>();

type ParsedRequest = { readonly after: number; readonly limit: number; readonly operations?: readonly WorldReadOperation[] };
type StoredRecord = Readonly<WorldReadLedgerRecord>;

const denied = (): never => { throw new WorldRuntimeError("world_runtime_denied"); };
const invalid = (): never => { throw new WorldRuntimeError("world_runtime_invalid_composition"); };
const isProxy = (value: unknown): boolean => value !== null && typeof value === "object" && types.isProxy(value as object);
const safeInteger = (value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const binding = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT && value === value.trim();
const object = (value: unknown, allowed: readonly string[], exact = false): Record<string, unknown> | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const keys = Reflect.ownKeys(value);
  if ((exact && keys.length !== allowed.length) || keys.some((key) => typeof key !== "string" || !allowed.includes(key))) return undefined;
  const output: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
    output[key as string] = descriptor.value;
  }
  return output;
};
const immutable = <T>(value: T): T => Object.freeze(value);
const cloneIdentity = (identity: WorldReadIdentity): WorldReadIdentity => immutable({ ...identity });
const cloneRecord = (record: WorldReadLedgerRecord): StoredRecord => immutable({
  ...record, ...(record.identity === undefined ? {} : { identity: cloneIdentity(record.identity) }),
});
const principalReservation = (value: unknown): readonly string[] | undefined => {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (!length || !("value" in length) || !safeInteger(length.value, 1, MAX_PRINCIPALS)
    || Reflect.ownKeys(value).length !== length.value + 1) return undefined;
  const principals: string[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const entry = Object.getOwnPropertyDescriptor(value, String(index));
    if (!entry?.enumerable || !("value" in entry) || !binding(entry.value)) return undefined;
    principals.push(entry.value);
  }
  return new Set(principals).size === principals.length ? principals : undefined;
};

export const parseWorldReadIdentity = (value: unknown): WorldReadIdentity | undefined => {
  const input = object(value, ["run_id", "world_id", "world_instance_id", "manifest_digest", "state_version"], true);
  if (input === undefined || !binding(input.run_id) || !binding(input.world_id) || !binding(input.world_instance_id)
    || typeof input.manifest_digest !== "string" || !SHA256.test(input.manifest_digest) || !safeInteger(input.state_version, 0)) return undefined;
  return cloneIdentity(input as unknown as WorldReadIdentity);
};
export const parseWorldReadLedgerRecord = (value: unknown): Omit<WorldReadLedgerRecord, "sequence"> | undefined => {
  const input = object(value, ["operation", "principal", "decision_id", "state_version", "result", "identity"]);
  if (input === undefined || !WORLD_READ_OPERATIONS.includes(input.operation as WorldReadOperation) || !binding(input.principal)
    || (input.result !== "allowed" && input.result !== "denied")) return undefined;
  if (input.result === "denied" && (input.decision_id !== undefined || input.state_version !== undefined || input.identity !== undefined)) return undefined;
  const identity = input.identity === undefined ? undefined : parseWorldReadIdentity(input.identity);
  if (input.result === "allowed" && (typeof input.decision_id !== "string" || !DECISION_ID.test(input.decision_id)
    || !safeInteger(input.state_version, 0) || identity === undefined || identity.state_version !== input.state_version)) return undefined;
  return immutable({ operation: input.operation as WorldReadOperation, principal: input.principal, result: input.result,
    ...(input.result === "denied" ? {} : { decision_id: input.decision_id as string, state_version: input.state_version as number, identity: identity! }),
  });
};

export const parseWorldReadLedgerRequest = (input: unknown): ParsedRequest => {
  if (input === undefined) return immutable({ after: 0, limit: DEFAULT_LIMIT });
  const value = object(input, ["after", "limit", "operations"]);
  if (value === undefined) return denied();
  const after = value.after === undefined ? 0 : value.after;
  const limit = value.limit === undefined ? DEFAULT_LIMIT : value.limit;
  if (!safeInteger(after, 0) || !safeInteger(limit, 1, MAX_LIMIT)) return denied();
  if (value.operations === undefined) return immutable({ after, limit });
  const array = value.operations;
  if (!Array.isArray(array) || isProxy(array) || Object.getPrototypeOf(array) !== Array.prototype) return denied();
  const length = Object.getOwnPropertyDescriptor(array, "length");
  if (!length || !("value" in length) || !safeInteger(length.value, 1, WORLD_READ_OPERATIONS.length) || Reflect.ownKeys(array).length !== length.value + 1) return denied();
  const operations: WorldReadOperation[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const entry = Object.getOwnPropertyDescriptor(array, String(index));
    if (!entry?.enumerable || !("value" in entry) || !WORLD_READ_OPERATIONS.includes(entry.value as WorldReadOperation)) return denied();
    operations.push(entry.value as WorldReadOperation);
  }
  if (new Set(operations).size !== operations.length) return denied();
  return immutable({ after, limit, operations: immutable(operations) });
};

/** @internal Exact local-module authority check used by world composition. */
export const readWorldReadLedger = (value: unknown): WorldReadLedgerAuthority | undefined =>
  value !== null && typeof value === "object" ? issuedLedgers.get(value) : undefined;

export const createWorldReadLedger = (options: unknown = {}): WorldReadLedger => {
  const parsed = object(options, ["maxEntriesPerPrincipal", "maxPrincipals"]);
  const maximum = parsed?.maxEntriesPerPrincipal === undefined ? DEFAULT_RETAINED_ENTRIES : parsed.maxEntriesPerPrincipal;
  const principals = parsed?.maxPrincipals === undefined ? DEFAULT_PRINCIPALS : parsed.maxPrincipals;
  if (parsed === undefined || !safeInteger(maximum, 1, MAX_RETAINED_ENTRIES) || !safeInteger(principals, 1, MAX_PRINCIPALS)) return invalid();
  const entries = new Map<string, StoredRecord[]>();
  const sequences = new Map<string, number>();
  let restored = false;
  const append = (input: WorldReadLedgerAppend): void => {
    const record = parseWorldReadLedgerRecord(input);
    if (record === undefined) return invalid();
    const known = entries.get(record.principal);
    if (restored && known === undefined) return invalid();
    if (known === undefined && entries.size >= principals) return invalid();
    const previous = sequences.get(record.principal) ?? 0;
    if (previous >= Number.MAX_SAFE_INTEGER) return invalid();
    const sequence = previous + 1;
    const stored = cloneRecord({ ...record, sequence });
    const retained = known === undefined ? [] : [...known];
    retained.push(stored);
    if (retained.length > maximum) retained.splice(0, retained.length - maximum);
    entries.set(record.principal, retained);
    sequences.set(record.principal, sequence);
  };
  const reservePrincipals = (input: unknown): void => {
    const reserved = principalReservation(input);
    if (reserved === undefined || entries.size > reserved.length
      || [...entries.keys()].some((principal) => !reserved.includes(principal))
      || reserved.length > principals
      || (restored && (entries.size !== reserved.length || reserved.some((principal) => !entries.has(principal))))) return invalid();
    for (const principal of reserved) if (!entries.has(principal)) entries.set(principal, []);
  };
  const snapshot = (): WorldReadLedgerSnapshot => cloneWorldReadLedgerSnapshot({
    version: "simfile.world-read-ledger.v1",
    max_entries_per_principal: maximum,
    max_principals: principals,
    lanes: [...entries.keys()].sort().map((principal) => {
      const records = entries.get(principal)!;
      const last_sequence = sequences.get(principal) ?? 0;
      return { principal, last_sequence, evicted_through: records[0]?.sequence === undefined ? last_sequence : records[0].sequence - 1, records };
    }),
  });
  const restore = (input: unknown): void => {
    if (restored || sequences.size !== 0 || [...entries.values()].some((records) => records.length !== 0)) return invalid();
    const parsedSnapshot = parseWorldReadLedgerSnapshot(input);
    if (parsedSnapshot === undefined || parsedSnapshot.max_entries_per_principal !== maximum || parsedSnapshot.max_principals !== principals) return invalid();
    const reserved = [...entries.keys()];
    if (reserved.length > 0 && (reserved.length !== parsedSnapshot.lanes.length || reserved.some((principal) => !parsedSnapshot.lanes.some((lane) => lane.principal === principal)))) return invalid();
    const nextEntries = new Map<string, StoredRecord[]>(); const nextSequences = new Map<string, number>();
    for (const lane of parsedSnapshot.lanes) { nextEntries.set(lane.principal, [...lane.records].map(cloneRecord)); nextSequences.set(lane.principal, lane.last_sequence); }
    entries.clear(); sequences.clear();
    for (const [principal, records] of nextEntries) entries.set(principal, records);
    for (const [principal, value] of nextSequences) sequences.set(principal, value);
    restored = true;
  };
  const read = (principal: string, request: unknown): WorldReadLedgerPage => {
      if (!binding(principal)) return denied();
      const parsedRequest = parseWorldReadLedgerRequest(request);
      const allowed = parsedRequest.operations === undefined ? undefined : new Set(parsedRequest.operations);
      const records = (entries.get(principal) ?? []).filter((record) => record.sequence > parsedRequest.after && (allowed === undefined || allowed.has(record.operation)))
        .slice(0, parsedRequest.limit).map(cloneRecord);
      return immutable({ records: immutable(records), next_after: records.at(-1)?.sequence ?? parsedRequest.after });
  };
  const authority = Object.freeze({ append, read, reservePrincipals, snapshot, restore });
  const ledger: WorldReadLedger = Object.freeze({ read });
  issuedLedgers.set(ledger, authority);
  return ledger;
};
