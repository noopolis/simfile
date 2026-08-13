import { DYNAMICS_LIMITS } from "../dynamics/limits.js";
import type { ReadonlyDynamicsJsonValue } from "../dynamics/types.js";
import type { QueuedWorldAction, WorldActionTerminal, WorldActQueuedReceipt } from "./actTypes.js";
import { copyHostileJson, type HostileJson } from "./hostileJson.js";
import { types } from "node:util";
import { assertNoWorldAuthorityFields } from "../world-surface/authority.js";

export const WORLD_ACTION_JOURNAL_VERSION = "simfile.world-action-journal.v1" as const;

export type ActionJournalAudit = Readonly<{ principal: string; result: "queued" | "denied" }>;
export type ActionJournalCellState = "authorized" | "terminal";
export interface ActionJournalSnapshotCell {
  readonly receipt: WorldActQueuedReceipt;
  readonly sequence: number;
  readonly state: ActionJournalCellState;
  readonly record: QueuedWorldAction;
  readonly terminal: WorldActionTerminal | null;
}
export interface WorldActionJournalSnapshot {
  readonly version: typeof WORLD_ACTION_JOURNAL_VERSION;
  readonly closed: boolean;
  readonly lanes: readonly Readonly<{ principal: string; count: number }>[];
  readonly audits: readonly ActionJournalAudit[];
  readonly cells: readonly ActionJournalSnapshotCell[];
}

type JsonRecord = Readonly<Record<string, HostileJson>>;

const JOURNAL_AUTHORITY_NAMES = new Set([
  "audit", "decision", "effect", "receipt", "run", "tick", "world",
  "receipt_id",
]);

const ADDRESS = /^world:\/\/(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/)+(?:entity|affordance)\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const DECISION = /^decision-[0-9]{12}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const RECEIPT = /^world-act-([1-9][0-9]*)$/u;
const binding = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= 256 && value === value.trim();
const tick = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const sequence = (value: unknown): value is number => tick(value) && value >= 1;
const frozen = <Value>(value: Value): Value => Object.freeze(value);
const fail = (): undefined => undefined;
const compareUtf16 = (left: string, right: string): number => left === right ? 0 : left < right ? -1 : 1;
const INDEX = /^(?:0|[1-9][0-9]*)$/u;
const DANGEROUS = new Set(["__proto__", "constructor", "prototype"]);

/* The journal can legitimately contain more JSON nodes than one generic value.
 * This scanner establishes one descriptor-only graph boundary first; records are
 * then copied under their own existing dynamics JSON budget. */
const scan = (value: unknown, seen: Set<object>, depth = 0): void => {
  if (depth > DYNAMICS_LIMITS.json_depth || value === null || typeof value !== "object") return;
  if (types.isProxy(value) || seen.has(value)) throw new TypeError("hostile journal snapshot");
  seen.add(value);
  const arrayValue = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if ((arrayValue && prototype !== Array.prototype) || (!arrayValue && prototype !== Object.prototype && prototype !== null)) throw new TypeError("hostile journal snapshot");
  for (let current: object | null = value; current !== null; current = Object.getPrototypeOf(current)) if (types.isProxy(current) || Object.getOwnPropertyDescriptor(current, "then") !== undefined) throw new TypeError("hostile journal snapshot");
  const keys = Reflect.ownKeys(value);
  if (arrayValue) {
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > DYNAMICS_LIMITS.retained_action_records || keys.length !== length.value + 1 || keys.some((key) => typeof key !== "string" || (key !== "length" && (!INDEX.test(key) || Number(key) >= length.value)))) throw new TypeError("hostile journal snapshot");
    for (let index = 0; index < length.value; index += 1) { const descriptor = Object.getOwnPropertyDescriptor(value, String(index)); if (!descriptor?.enumerable || !("value" in descriptor)) throw new TypeError("hostile journal snapshot"); scan(descriptor.value, seen, depth + 1); }
    return;
  }
  for (const key of keys) { if (typeof key !== "string" || DANGEROUS.has(key)) throw new TypeError("hostile journal snapshot"); const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor?.enumerable || !("value" in descriptor)) throw new TypeError("hostile journal snapshot"); scan(descriptor.value, seen, depth + 1); }
};
const outer = (value: unknown): readonly unknown[] => {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError("hostile journal snapshot");
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > DYNAMICS_LIMITS.retained_action_records) throw new TypeError("hostile journal snapshot");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length.value + 1 || keys.some((key) => typeof key !== "string" || (key !== "length" && (!INDEX.test(key) || Number(key) >= length.value)))) throw new TypeError("hostile journal snapshot");
  const result: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) { const descriptor = Object.getOwnPropertyDescriptor(value, String(index)); if (!descriptor?.enumerable || !("value" in descriptor)) throw new TypeError("hostile journal snapshot"); result.push(descriptor.value); }
  return result;
};
const journalBoundary = (input: unknown): HostileJson => {
  if (input === null || typeof input !== "object" || Array.isArray(input) || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError("hostile journal snapshot");
  const keys = Reflect.ownKeys(input);
  const expected = ["version", "closed", "lanes", "audits", "cells"];
  if (keys.length !== expected.length || keys.some((key) => typeof key !== "string" || !expected.includes(key))) throw new TypeError("hostile journal snapshot");
  const root: Record<string, HostileJson> = Object.create(null);
  const seen = new Set<object>(); scan(input, seen);
  for (const key of expected) { const descriptor = Object.getOwnPropertyDescriptor(input, key); if (!descriptor?.enumerable || !("value" in descriptor)) throw new TypeError("hostile journal snapshot"); if (key === "lanes" || key === "audits" || key === "cells") root[key] = frozen(outer(descriptor.value).map((entry) => copyHostileJson(entry))); else root[key] = copyHostileJson(descriptor.value); }
  return frozen(root);
};

const assertNoJournalAuthorityNames = (value: HostileJson, path: string): void => {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoJournalAuthorityNames(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (JOURNAL_AUTHORITY_NAMES.has(key)) throw new TypeError(`${path}.${key} is reserved for journal authority`);
    assertNoJournalAuthorityNames(child, `${path}.${key}`);
  }
};

const object = (value: HostileJson, fields: readonly string[]): JsonRecord | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail();
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field)) ? value as JsonRecord : fail();
};

const array = (value: HostileJson): readonly HostileJson[] | undefined => Array.isArray(value) ? value : fail();
const jsonObject = (value: HostileJson): Readonly<Record<string, HostileJson>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : fail();

const canonicalAddress = (value: unknown): value is string => typeof value === "string" && ADDRESS.test(value);
const canonicalReceipt = (value: unknown, expectedSequence?: number): value is string => {
  if (typeof value !== "string") return false;
  const match = RECEIPT.exec(value);
  return match !== null && (expectedSequence === undefined || Number(match[1]) === expectedSequence);
};

const parseIdentity = (value: HostileJson): WorldActQueuedReceipt["identity"] | undefined => {
  const item = object(value, ["run_id", "world_id", "world_instance_id", "manifest_digest", "state_version"]);
  if (item === undefined || !binding(item.run_id) || !binding(item.world_id) || !binding(item.world_instance_id)
    || typeof item.manifest_digest !== "string" || !DIGEST.test(item.manifest_digest) || !tick(item.state_version)) return fail();
  return frozen({ run_id: item.run_id, world_id: item.world_id, world_instance_id: item.world_instance_id,
    manifest_digest: item.manifest_digest, state_version: item.state_version });
};

const sameIdentity = (left: WorldActQueuedReceipt["identity"], right: WorldActQueuedReceipt["identity"]): boolean =>
  left.run_id === right.run_id && left.world_id === right.world_id && left.world_instance_id === right.world_instance_id
  && left.manifest_digest === right.manifest_digest && left.state_version === right.state_version;

const parseReceipt = (value: HostileJson, expectedSequence?: number): WorldActQueuedReceipt | undefined => {
  const item = object(value, ["disposition", "receipt_id", "decision_id", "identity", "apply_tick"]);
  const identity = item === undefined ? undefined : parseIdentity(item.identity);
  if (item === undefined || item.disposition !== "queued" || !canonicalReceipt(item.receipt_id, expectedSequence)
    || typeof item.decision_id !== "string" || !DECISION.test(item.decision_id) || !tick(item.apply_tick) || identity === undefined) return fail();
  return frozen({ disposition: "queued", receipt_id: item.receipt_id, decision_id: item.decision_id,
    identity, apply_tick: item.apply_tick });
};

const parseQueued = (value: HostileJson, receipt: WorldActQueuedReceipt, expectedSequence: number): QueuedWorldAction | undefined => {
  const fields = ["receipt_id", "decision_id", "principal", "holder", "affordance", "target", "at_tick",
    "dynamics_sequence", "mechanics_action", "mechanics_actor", "mechanics_target", "lowered_input", "identity"];
  const item = object(value, fields); const identity = item === undefined ? undefined : parseIdentity(item.identity);
  const lowered = item === undefined ? undefined : jsonObject(item.lowered_input);
  if (lowered !== undefined) {
    assertNoWorldAuthorityFields(lowered as ReadonlyDynamicsJsonValue, "restored lowered mechanics input");
    assertNoJournalAuthorityNames(lowered, "restored lowered mechanics input");
  }
  if (item === undefined || item.receipt_id !== receipt.receipt_id || item.decision_id !== receipt.decision_id
    || !binding(item.principal) || !canonicalAddress(item.holder) || !canonicalAddress(item.affordance)
    || !canonicalAddress(item.target) || !tick(item.at_tick) || item.at_tick !== receipt.apply_tick
    || item.dynamics_sequence !== expectedSequence || !binding(item.mechanics_action) || !binding(item.mechanics_actor)
    || !binding(item.mechanics_target) || lowered === undefined || identity === undefined || !sameIdentity(identity, receipt.identity)) return fail();
  return frozen({ receipt_id: receipt.receipt_id, decision_id: receipt.decision_id, principal: item.principal,
    holder: item.holder, affordance: item.affordance, target: item.target, at_tick: item.at_tick,
    dynamics_sequence: expectedSequence, mechanics_action: item.mechanics_action, mechanics_actor: item.mechanics_actor,
    mechanics_target: item.mechanics_target, lowered_input: lowered, identity });
};

const parseTerminal = (value: HostileJson, receipt: WorldActQueuedReceipt, expectedSequence: number): WorldActionTerminal | undefined => {
  const base = ["disposition", "receipt_id", "decision_id", "sequence", "apply_tick", "projection"];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail();
  const raw = value as JsonRecord;
  const projected = raw.projection === "projected";
  const rejected = raw.disposition === "rejected_at_mechanics";
  const fields = [...base, ...(projected ? ["effect"] : []), ...(rejected && Object.hasOwn(raw, "public_code") ? ["public_code"] : [])];
  const item = object(value, fields);
  if (item === undefined || (item.disposition !== "applied" && item.disposition !== "rejected_at_mechanics")
    || item.receipt_id !== receipt.receipt_id || item.decision_id !== receipt.decision_id || item.sequence !== expectedSequence
    || item.apply_tick !== receipt.apply_tick || (item.projection !== "not_configured" && item.projection !== "projected" && item.projection !== "failed")
    || (item.disposition === "rejected_at_mechanics" && item.projection !== "not_configured")
    || (item.disposition === "applied" && Object.hasOwn(item, "public_code"))
    || (Object.hasOwn(item, "public_code") && !binding(item.public_code))) return fail();
  const effect = projected ? jsonObject(item.effect) : undefined;
  if (effect !== undefined) {
    assertNoWorldAuthorityFields(effect as ReadonlyDynamicsJsonValue, "restored projected effect");
    assertNoJournalAuthorityNames(effect, "restored projected effect");
  }
  if (projected && (effect === undefined || item.disposition !== "applied")) return fail();
  return frozen({ disposition: item.disposition, receipt_id: receipt.receipt_id, decision_id: receipt.decision_id,
    sequence: expectedSequence, apply_tick: receipt.apply_tick, projection: item.projection,
    ...(item.public_code === undefined ? {} : { public_code: item.public_code as string }), ...(effect === undefined ? {} : { effect: effect as WorldActionTerminal["effect"] }) });
};

const parseSnapshot = (root: HostileJson): WorldActionJournalSnapshot | undefined => {
  const item = object(root, ["version", "closed", "lanes", "audits", "cells"]);
  const laneValues = item === undefined ? undefined : array(item.lanes);
  const auditValues = item === undefined ? undefined : array(item.audits);
  const cellValues = item === undefined ? undefined : array(item.cells);
  if (item === undefined || item.version !== WORLD_ACTION_JOURNAL_VERSION || typeof item.closed !== "boolean"
    || laneValues === undefined || auditValues === undefined || cellValues === undefined
    || laneValues.length > DYNAMICS_LIMITS.retained_action_records || auditValues.length > DYNAMICS_LIMITS.retained_action_records
    || cellValues.length > DYNAMICS_LIMITS.retained_action_records) return fail();
  const lanes: Array<Readonly<{ principal: string; count: number }>> = [];
  const laneSet = new Set<string>();
  for (const value of laneValues) {
    const lane = object(value, ["principal", "count"]);
    const principal = lane?.principal; const count = lane?.count;
    if (!binding(principal) || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0
      || count > DYNAMICS_LIMITS.retained_action_records || laneSet.has(principal)) return fail();
    laneSet.add(principal); lanes.push(frozen({ principal, count }));
  }
  lanes.sort((left, right) => left.principal < right.principal ? -1 : left.principal > right.principal ? 1 : 0);
  const audits: ActionJournalAudit[] = [];
  const auditCounts = new Map<string, number>();
  const queuedAuditCounts = new Map<string, number>();
  for (const value of auditValues) {
    const audit = object(value, ["principal", "result"]);
    const principal = audit?.principal; const result = audit?.result;
    if (!binding(principal) || !laneSet.has(principal) || (result !== "queued" && result !== "denied")) return fail();
    audits.push(frozen({ principal, result }));
    auditCounts.set(principal, (auditCounts.get(principal) ?? 0) + 1);
    if (result === "queued") queuedAuditCounts.set(principal, (queuedAuditCounts.get(principal) ?? 0) + 1);
  }
  audits.sort((left, right) => compareUtf16(left.principal, right.principal)
    || compareUtf16(left.result, right.result));
  if (lanes.some((lane) => (auditCounts.get(lane.principal) ?? 0) !== lane.count)) return fail();
  const cells: ActionJournalSnapshotCell[] = [];
  const receipts = new Set<string>(); const sequences = new Set<number>();
  for (const value of cellValues) {
    const cell = object(value, ["receipt", "sequence", "state", "record", "terminal"]);
    if (cell === undefined || !sequence(cell.sequence) || receipts.has((cell.receipt as JsonRecord)?.receipt_id as string)
      || sequences.has(cell.sequence) || (cell.state !== "authorized" && cell.state !== "terminal")) return fail();
    const receipt = parseReceipt(cell.receipt, cell.sequence);
    const record = receipt === undefined ? undefined : parseQueued(cell.record, receipt, cell.sequence);
    const terminal = cell.terminal === null ? null : receipt === undefined ? undefined : parseTerminal(cell.terminal, receipt, cell.sequence);
    if (receipt === undefined || record === undefined || terminal === undefined || (cell.state === "authorized" && terminal !== null)
      || (cell.state === "terminal" && terminal === null) || !laneSet.has(record.principal)) return fail();
    receipts.add(receipt.receipt_id); sequences.add(cell.sequence);
    cells.push(frozen({ receipt, sequence: cell.sequence, state: cell.state, record, terminal }));
  }
  cells.sort((left, right) => left.sequence - right.sequence);
  const cellCounts = new Map<string, number>();
  for (const cell of cells) cellCounts.set(cell.record.principal, (cellCounts.get(cell.record.principal) ?? 0) + 1);
  for (const lane of lanes) {
    const queuedAudits = queuedAuditCounts.get(lane.principal) ?? 0;
    if (queuedAudits !== (cellCounts.get(lane.principal) ?? 0)) return fail();
  }
  return frozen({ version: WORLD_ACTION_JOURNAL_VERSION, closed: item.closed, lanes: frozen(lanes), audits: frozen(audits), cells: frozen(cells) });
};

/** Bounded outer lanes are scanned before any element is touched; records copy independently. */
export const parseWorldActionJournalSnapshot = (input: unknown): WorldActionJournalSnapshot | undefined => {
  try { return parseSnapshot(journalBoundary(input)); } catch { return undefined; }
};

export const parseWorldActionReceipt = (input: unknown, expectedSequence?: number): WorldActQueuedReceipt | undefined => {
  try { return parseReceipt(copyHostileJson(input), expectedSequence); } catch { return undefined; }
};

export const parseQueuedWorldAction = (
  input: unknown,
  receipt: WorldActQueuedReceipt,
  expectedSequence: number,
): QueuedWorldAction | undefined => {
  try { return parseQueued(copyHostileJson(input), receipt, expectedSequence); } catch { return undefined; }
};

export const parseWorldActionTerminal = (
  input: unknown,
  receipt: WorldActQueuedReceipt,
  expectedSequence: number,
): WorldActionTerminal | undefined => {
  try { return parseTerminal(copyHostileJson(input), receipt, expectedSequence); } catch { return undefined; }
};

export const cloneWorldActionJournalSnapshot = (input: WorldActionJournalSnapshot): WorldActionJournalSnapshot => {
  const parsed = parseWorldActionJournalSnapshot(input);
  if (parsed === undefined) throw new TypeError("invalid world action journal snapshot");
  return parsed;
};
