import { DYNAMICS_LIMITS } from "../dynamics/limits.js";
import type { QueuedWorldAction, WorldActQueuedReceipt } from "./actTypes.js";
import { parseWorldActEnvelope, type ParsedWorldActEnvelope } from "./actEnvelope.js";
import { copySafeUint8Array, readDataObject } from "./decisionRegistrySnapshot.js";
import {
  parseWorldRequestLedgerSnapshot,
  sameWorldRequestAuthority,
  sameWorldRequestBytes,
  worldRequestLedgerRecordCodeUnits,
  type WorldRequestAuthority,
  type WorldRequestLedgerSnapshot,
  type WorldRequestLedgerSnapshotRecord,
} from "./requestLedgerSnapshot.js";
import { parseQueuedWorldAction, parseWorldActionReceipt } from "./actionJournalSnapshot.js";

export type { WorldRequestAuthority, WorldRequestLedgerSnapshot, WorldRequestLedgerSnapshotRecord } from "./requestLedgerSnapshot.js";

export interface WorldRequestLedgerClaimInput { readonly bytes: Uint8Array; readonly authority: WorldRequestAuthority; }
export interface WorldRequestReservation {
  readonly request_id: string;
  readonly request_bytes: readonly number[];
  prepare(input: WorldRequestPreparation): void;
  commit(): void;
  abort(): void;
}
export interface WorldRequestPreparation { readonly at_tick: number; readonly queued_action: QueuedWorldAction; readonly receipt: WorldActQueuedReceipt; }
export type WorldRequestClaimResult =
  | Readonly<{ kind: "new"; envelope: ParsedWorldActEnvelope; reservation: WorldRequestReservation }>
  | Readonly<{ kind: "replay"; receipt: WorldActQueuedReceipt }>
  | Readonly<{ kind: "malformed" }>
  | Readonly<{ kind: "conflict" }>;
export interface WorldRequestLedgerConfig { readonly max_records?: number; readonly max_code_units?: number; }
export interface WorldRequestLedger {
  beginClaim(input: unknown): WorldRequestClaimResult;
  begin(input: unknown): WorldRequestClaimResult;
  snapshot(): WorldRequestLedgerSnapshot;
  restore(input: unknown): void;
  close(): void;
  readonly size: number;
  readonly closed: boolean;
}

type InternalRecord = WorldRequestLedgerSnapshotRecord;
type Slot = { state: "claimed" | "prepared" | "committed"; record?: InternalRecord; units: number; stale: boolean };
const issuedLedgers = new WeakSet<object>();
const binding = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= DYNAMICS_LIMITS.identifier_code_units && value === value.trim();
const tick = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const frozen = <Value>(value: Value): Value => Object.freeze(value);
const stale = (): never => { throw new Error("stale world request reservation"); };
const invalid = (): never => { throw new Error("invalid world request reservation"); };
const closedError = (): Error => new Error("world request ledger closed");

const safeAuthority = (value: unknown): WorldRequestAuthority | undefined => {
  const source = readDataObject(value, ["principal", "run_id", "world_id", "world_instance_id"]);
  if (source === undefined || Reflect.ownKeys(value as object).length !== 4 || !binding(source.principal)
    || !binding(source.run_id) || !binding(source.world_id) || !binding(source.world_instance_id)) return undefined;
  return frozen({ principal: source.principal, run_id: source.run_id, world_id: source.world_id, world_instance_id: source.world_instance_id });
};
const safeClaim = (value: unknown): WorldRequestLedgerClaimInput | undefined => {
  const source = readDataObject(value, ["bytes", "authority"]);
  if (source === undefined || Reflect.ownKeys(value as object).length !== 2) return undefined;
  const bytes = copySafeUint8Array(source.bytes); const authority = safeAuthority(source.authority);
  return bytes === undefined || authority === undefined ? undefined : { bytes, authority };
};
const copyReceipt = (receipt: WorldActQueuedReceipt): WorldActQueuedReceipt => frozen({
  disposition: "queued", receipt_id: receipt.receipt_id, decision_id: receipt.decision_id,
  identity: frozen({ ...receipt.identity }), apply_tick: receipt.apply_tick,
});
const identityMatches = (authority: WorldRequestAuthority, action: QueuedWorldAction, receipt: WorldActQueuedReceipt): boolean =>
  action.principal === authority.principal && action.identity.run_id === authority.run_id
  && action.identity.world_id === authority.world_id && action.identity.world_instance_id === authority.world_instance_id
  && receipt.identity.run_id === authority.run_id && receipt.identity.world_id === authority.world_id
  && receipt.identity.world_instance_id === authority.world_instance_id;

const makeRecord = (envelope: ParsedWorldActEnvelope, authority: WorldRequestAuthority, input: WorldRequestPreparation): InternalRecord | undefined => {
  if (!tick(input.at_tick)) return undefined;
  const match = typeof input.receipt.receipt_id === "string" ? /^world-act-([1-9][0-9]*)$/u.exec(input.receipt.receipt_id) : null;
  const sequence = match === null ? NaN : Number(match[1]);
  if (!Number.isSafeInteger(sequence) || sequence < 1) return undefined;
  const receipt = parseWorldActionReceipt(input.receipt, sequence);
  const action = receipt === undefined ? undefined : parseQueuedWorldAction(input.queued_action, receipt, sequence);
  if (receipt === undefined || action === undefined || input.at_tick !== receipt.apply_tick || action.at_tick !== input.at_tick
    || action.affordance !== envelope.affordance || action.target !== envelope.target || !identityMatches(authority, action, receipt)) return undefined;
  return frozen({ request_id: envelope.request_id, authority: frozen({ ...authority }), request_bytes: frozen(Array.from(envelope.bytes)),
    at_tick: input.at_tick, queued_action: action, receipt });
};

export const readWorldRequestLedger = (value: unknown): WorldRequestLedger | undefined =>
  value !== null && typeof value === "object" && issuedLedgers.has(value) ? value as WorldRequestLedger : undefined;

export const createWorldRequestLedger = (config: WorldRequestLedgerConfig = {}): WorldRequestLedger => {
  const maxRecords = config.max_records ?? DYNAMICS_LIMITS.retained_action_records;
  const maxCodeUnits = config.max_code_units ?? DYNAMICS_LIMITS.retained_action_code_units;
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > DYNAMICS_LIMITS.retained_action_records
    || !Number.isSafeInteger(maxCodeUnits) || maxCodeUnits < 1 || maxCodeUnits > DYNAMICS_LIMITS.retained_action_code_units) throw new TypeError("invalid world request ledger limits");
  const slots = new Map<string, Slot>();
  let committedUnits = 0; let reservedUnits = 0; let committedSize = 0; let closed = false; let restoreAllowed = true;
  const closeLedger = (): void => {
    closed = true;
    for (const [id, slot] of slots) if (slot.state !== "committed") { slot.stale = true; slots.delete(id); reservedUnits -= slot.units; }
  };
  const closeAndThrow = (message: string): never => { closeLedger(); throw new Error(message); };
  const beginClaim = (input: unknown): WorldRequestClaimResult => {
    const claim = safeClaim(input); if (claim === undefined) return { kind: "malformed" };
    let envelope: ParsedWorldActEnvelope; try { envelope = parseWorldActEnvelope(claim.bytes); } catch { return { kind: "malformed" }; }
    const existing = slots.get(envelope.request_id);
    if (existing?.state === "committed" && existing.record !== undefined) {
      return sameWorldRequestBytes(existing.record.request_bytes, envelope.bytes) && sameWorldRequestAuthority(existing.record.authority, claim.authority)
        ? frozen({ kind: "replay", receipt: copyReceipt(existing.record.receipt) }) : frozen({ kind: "conflict" });
    }
    if (closed) return frozen({ kind: "conflict" });
    if (existing !== undefined) return frozen({ kind: "conflict" });
    if (slots.size >= maxRecords || envelope.bytes.length > maxCodeUnits) return closeAndThrow("world request ledger capacity exhausted");
    const slot: Slot = { state: "claimed", units: 0, stale: false }; slots.set(envelope.request_id, slot);
    const requireLive = (): void => { if (closed || slot.stale || slots.get(envelope.request_id) !== slot) stale(); };
    const prepare = (preparation: WorldRequestPreparation): void => {
      requireLive(); if (slot.state !== "claimed" || preparation === null || typeof preparation !== "object") invalid();
      const source = readDataObject(preparation, ["at_tick", "queued_action", "receipt"]);
      if (source === undefined || Reflect.ownKeys(preparation).length !== 3) invalid();
      const record = makeRecord(envelope, claim.authority, source as unknown as WorldRequestPreparation); if (record === undefined) return invalid();
      const units = worldRequestLedgerRecordCodeUnits(record);
      if (units > maxCodeUnits || committedUnits + reservedUnits + units > maxCodeUnits) closeAndThrow("world request ledger capacity exhausted");
      slot.record = record; slot.units = units; slot.state = "prepared"; reservedUnits += units;
    };
    const commit = (): void => { requireLive(); if (slot.state !== "prepared" || slot.record === undefined) invalid();
      slot.state = "committed"; reservedUnits -= slot.units; committedUnits += slot.units; committedSize += 1; };
    const abort = (): void => { requireLive(); if (slot.state !== "claimed" && slot.state !== "prepared") stale();
      if (slot.state === "prepared") reservedUnits -= slot.units; slot.stale = true; slots.delete(envelope.request_id); };
    const reservation = frozen<WorldRequestReservation>({ request_id: envelope.request_id, request_bytes: frozen(Array.from(envelope.bytes)), prepare, commit, abort });
    return frozen({ kind: "new", envelope, reservation });
  };
  const snapshot = (): WorldRequestLedgerSnapshot => {
    if ([...slots.values()].some((slot) => slot.state !== "committed")) throw new Error("world request ledger is not quiescent");
    const records = [...slots.values()].filter((slot): slot is Slot & { record: InternalRecord } => slot.state === "committed" && slot.record !== undefined)
      .map((slot) => frozen({ ...slot.record, authority: frozen({ ...slot.record.authority }), request_bytes: frozen(Array.from(slot.record.request_bytes)), receipt: copyReceipt(slot.record.receipt) }))
      .sort((left, right) => left.request_id === right.request_id ? 0 : left.request_id < right.request_id ? -1 : 1);
    return frozen({ version: "simfile.world-request-ledger.v1", closed, record_count: records.length, code_units: committedUnits, records: frozen(records) });
  };
  const restore = (input: unknown): void => {
    if (!restoreAllowed || closed || slots.size !== 0 || committedUnits !== 0 || reservedUnits !== 0) throw new Error("world request ledger is not pristine");
    const parsed = parseWorldRequestLedgerSnapshot(input);
    if (parsed === undefined || parsed.records.length > maxRecords || parsed.code_units > maxCodeUnits) throw new TypeError("invalid world request ledger snapshot");
    for (const record of parsed.records) slots.set(record.request_id, { state: "committed", record, units: worldRequestLedgerRecordCodeUnits(record), stale: false });
    committedUnits = parsed.code_units; committedSize = parsed.records.length; closed = parsed.closed; restoreAllowed = false;
  };
  const ledger: WorldRequestLedger = Object.freeze({ beginClaim, begin: beginClaim, snapshot, restore, close: closeLedger,
    get size(): number { return committedSize; }, get closed(): boolean { return closed; } });
  issuedLedgers.add(ledger as object); return ledger;
};
