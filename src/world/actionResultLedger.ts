import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { types } from "node:util";

import { DYNAMICS_LIMITS } from "../dynamics/limits.js";
import { parseWorldActionResult, type WorldActionResult } from "./actionResult.js";
import { WorldRuntimeError } from "./ledger.js";

export const WORLD_ACTION_RESULT_PAGE_REQUEST_VERSION = "simfile.world-action-result-page-request.v1" as const;
export const WORLD_ACTION_RESULT_CURSOR_VERSION = "simfile.world-action-result-cursor.v1" as const;
export const WORLD_ACTION_RESULT_LEDGER_SNAPSHOT_VERSION = "simfile.world-action-result-ledger.v1" as const;
export interface WorldActionResultCursor { readonly version: typeof WORLD_ACTION_RESULT_CURSOR_VERSION; readonly issuer: string; readonly principal: string; readonly run_id: string; readonly world_id: string; readonly world_instance_id: string; readonly manifest_digest: string; readonly after: number; readonly proof: string; }
export interface WorldActionResultPageRequest { readonly version: typeof WORLD_ACTION_RESULT_PAGE_REQUEST_VERSION; readonly limit: number; readonly result_after?: WorldActionResultCursor; }
export interface WorldActionResultPage { readonly results: readonly WorldActionResult[]; readonly next_result_after?: WorldActionResultCursor; }
export interface WorldActionResultLedger { read(principal: string, request: unknown): WorldActionResultPage; }
export interface WorldActionResultLedgerOptions { readonly maxEntriesPerPrincipal?: number; readonly maxPrincipals?: number; }
export interface WorldActionResultBatchReservation { resultId(index: number): string; effectId(index: number): string; publish(results: readonly WorldActionResult[]): void; abort(): void; }
export interface WorldActionResultLedgerAuthority {
  append(input: unknown): void; read(principal: string, request: unknown): WorldActionResultPage; reserve(input: unknown): void;
  reserveBatch(input: unknown): WorldActionResultBatchReservation; exportState(): LedgerSnapshotState; importState(state: LedgerSnapshotState): void;
  hasLiveReservation(): boolean;
}
export type LedgerBinding = Readonly<{ principal: string; actor: string; run_id: string; world_id: string; world_instance_id: string; manifest_digest: string }>;
export type LedgerEntry = Readonly<{ page: number; result: WorldActionResult }>;
export interface LedgerSnapshotState {
  readonly version: typeof WORLD_ACTION_RESULT_LEDGER_SNAPSHOT_VERSION; readonly max_entries: number; readonly max_principals: number;
  readonly issuer: string; readonly secret: string; readonly bindings: readonly LedgerBinding[]; readonly entries: readonly Readonly<{ principal: string; values: readonly LedgerEntry[] }> [];
  readonly pages: readonly Readonly<[string, number]>[]; readonly evicted: readonly Readonly<[string, number]>[];
  readonly result_ids: readonly string[]; readonly receipt_ids: readonly string[]; readonly decision_ids: readonly string[]; readonly action_sequences: readonly number[];
  readonly effect_watermarks: readonly number[];
  readonly admitted: number; readonly previous_action: number; readonly next_result: number; readonly next_effect: number;
}

const DEFAULT_LIMIT = 50, MAX_LIMIT = 100, DEFAULT_ENTRIES = 256, DEFAULT_PRINCIPALS = 256;
const MAX_ENTRIES = DYNAMICS_LIMITS.retained_action_records, MAX_PRINCIPALS = 4_096, TEXT = DYNAMICS_LIMITS.identifier_code_units;
/** A successor must remain representable by the standalone snapshot parser. */
const MAX_NEXT_COUNTER = Number.MAX_SAFE_INTEGER - 1;
const SHA256 = /^sha256:[a-f0-9]{64}$/u, ADDRESS = /^world:\/\/(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/)+entity\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const RESULT = /^world-result-([1-9][0-9]*)$/u, EFFECT = /^world-effect-([1-9][0-9]*)$/u, ACT = /^world-act-[1-9][0-9]*$/u, DECISION = /^decision-[0-9]{12}$/u, CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const issued = new WeakMap<object, WorldActionResultLedgerAuthority>();
const frozen = <T>(value: T): T => Object.freeze(value);
const safe = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= TEXT && value === value.trim();
const invalid = (): never => { throw new WorldRuntimeError("world_runtime_invalid_composition"); };
const denied = (): never => { throw new WorldRuntimeError("world_runtime_denied"); };
const own = (value: unknown, allowed: readonly string[], exact = false): Record<string, unknown> | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const keys = Reflect.ownKeys(value); if ((exact && keys.length !== allowed.length) || keys.some((key) => typeof key !== "string" || !allowed.includes(key))) return undefined;
  const out: Record<string, unknown> = Object.create(null);
  for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor?.enumerable || !("value" in descriptor)) return undefined; out[key as string] = descriptor.value; }
  return out;
};
const array = (value: unknown, max: number, min = 0): readonly unknown[] | undefined => {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!safe(length, min, max) || Reflect.ownKeys(value).length !== length + 1) return undefined;
  const out: unknown[] = [];
  for (let index = 0; index < length; index += 1) { const descriptor = Object.getOwnPropertyDescriptor(value, String(index)); if (!descriptor?.enumerable || !("value" in descriptor)) return undefined; out.push(descriptor.value); }
  return out;
};
const numberSuffix = (value: string, expression: RegExp): number | undefined => { const match = expression.exec(value); if (!match) return undefined; const number = Number(match[1]); return safe(number, 1) ? number : undefined; };
const clone = (value: WorldActionResult): WorldActionResult => parseWorldActionResult(value)!;
const binding = (value: unknown): LedgerBinding | undefined => {
  const source = own(value, ["principal", "actor", "run_id", "world_id", "world_instance_id", "manifest_digest"], true);
  if (source === undefined || !text(source.principal) || typeof source.actor !== "string" || !ADDRESS.test(source.actor) || !text(source.run_id) || !text(source.world_id) || !text(source.world_instance_id) || typeof source.manifest_digest !== "string" || !SHA256.test(source.manifest_digest) || !source.actor.startsWith(`world://${source.world_id}/entity/`)) return undefined;
  return frozen({ principal: source.principal, actor: source.actor, run_id: source.run_id, world_id: source.world_id, world_instance_id: source.world_instance_id, manifest_digest: source.manifest_digest });
};
const codes = (value: unknown): readonly string[] | undefined => {
  if (value === undefined) return frozen([]); const values = array(value, MAX_ENTRIES);
  return values !== undefined && values.every((item) => typeof item === "string" && CODE.test(item)) && new Set(values).size === values.length ? frozen([...values] as string[]) : undefined;
};
const hmac = (secret: Buffer, fields: readonly string[]): string => createHmac("sha256", secret).update(fields.join("\u0000")).digest("hex");
const cursor = (value: unknown): WorldActionResultCursor | undefined => {
  const source = own(value, ["version", "issuer", "principal", "run_id", "world_id", "world_instance_id", "manifest_digest", "after", "proof"], true);
  if (source === undefined || source.version !== WORLD_ACTION_RESULT_CURSOR_VERSION || typeof source.issuer !== "string" || !/^[a-f0-9]{32}$/u.test(source.issuer) || !text(source.principal) || !text(source.run_id) || !text(source.world_id) || !text(source.world_instance_id) || typeof source.manifest_digest !== "string" || !SHA256.test(source.manifest_digest) || !safe(source.after, 0) || typeof source.proof !== "string" || !/^[a-f0-9]{64}$/u.test(source.proof)) return undefined;
  return frozen({ version: WORLD_ACTION_RESULT_CURSOR_VERSION, issuer: source.issuer, principal: source.principal, run_id: source.run_id, world_id: source.world_id, world_instance_id: source.world_instance_id, manifest_digest: source.manifest_digest, after: source.after, proof: source.proof });
};

export const parseWorldActionResultPageRequest = (input: unknown): WorldActionResultPageRequest | undefined => {
  const source = own(input, ["version", "limit", "result_after"]); const after = source?.result_after === undefined ? undefined : cursor(source.result_after);
  if (source === undefined || source.version !== WORLD_ACTION_RESULT_PAGE_REQUEST_VERSION || !safe(source.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT) || (source.result_after !== undefined && after === undefined)) return undefined;
  return frozen({ version: WORLD_ACTION_RESULT_PAGE_REQUEST_VERSION, limit: source.limit as number ?? DEFAULT_LIMIT, ...(after === undefined ? {} : { result_after: after }) });
};
export const readWorldActionResultLedger = (value: unknown): WorldActionResultLedgerAuthority | undefined => value !== null && typeof value === "object" ? issued.get(value) : undefined;

export const createWorldActionResultLedger = (options: unknown = {}): WorldActionResultLedger => {
  const option = own(options, ["maxEntriesPerPrincipal", "maxPrincipals"]); const maximum = option?.maxEntriesPerPrincipal ?? DEFAULT_ENTRIES, capacity = option?.maxPrincipals ?? DEFAULT_PRINCIPALS;
  if (option === undefined || !safe(maximum, 1, MAX_ENTRIES) || !safe(capacity, 1, MAX_PRINCIPALS)) return invalid();
  let bindings = new Map<string, LedgerBinding>(), entries = new Map<string, LedgerEntry[]>(), pages = new Map<string, number>(), evicted = new Map<string, number>();
  let resultIds = new Set<string>(), receiptIds = new Set<string>(), decisionIds = new Set<string>(), actionSequences = new Set<number>();
  let effectWatermarks: number[] = [];
  let issuer = randomBytes(16).toString("hex"), secret = randomBytes(32), admitted = 0, previousAction = 0, nextResult = 1, nextEffect = 1, restoreUsed = false;
  let live: { readonly actions: readonly Readonly<{ principal: string; receipt_id: string; decision_id: string; action_sequence: number; codes: readonly string[] }>[]; readonly effectCapacity: number; readonly resultStart: number; readonly effectStart: number } | undefined;
  const bound = (result: WorldActionResult, principal: string, declared: readonly string[]): boolean => {
    const target = bindings.get(principal);
    return target !== undefined && result.actor === target.actor && result.identity.run_id === target.run_id && result.identity.world_id === target.world_id && result.identity.world_instance_id === target.world_instance_id && result.identity.manifest_digest === target.manifest_digest && (result.status === "applied" || result.rejection_code === "world_action_rejected" || declared.includes(result.rejection_code));
  };
  const add = (principal: string, result: WorldActionResult, effectWatermark: number): void => {
    const page = (pages.get(principal) ?? 0) + 1, retained = [...entries.get(principal)!, frozen({ page, result: clone(result) })];
    if (retained.length > maximum) evicted.set(principal, retained.splice(0, retained.length - maximum).at(-1)!.page);
    entries.set(principal, retained); pages.set(principal, page); resultIds.add(result.result_id); receiptIds.add(result.receipt_id); decisionIds.add(result.decision_id); actionSequences.add(result.action_sequence);
    admitted += 1; previousAction = result.action_sequence; effectWatermarks.push(effectWatermark);
  };
  const makeCursor = (target: LedgerBinding, after: number): WorldActionResultCursor => frozen({ version: WORLD_ACTION_RESULT_CURSOR_VERSION, issuer, principal: target.principal, run_id: target.run_id, world_id: target.world_id, world_instance_id: target.world_instance_id, manifest_digest: target.manifest_digest, after, proof: hmac(secret, [issuer, target.principal, target.actor, target.run_id, target.world_id, target.world_instance_id, target.manifest_digest, String(after)]) });
  const parseCursor = (value: unknown, target: LedgerBinding): number | undefined => { const parsed = cursor(value); if (parsed === undefined || parsed.issuer !== issuer || parsed.principal !== target.principal || parsed.run_id !== target.run_id || parsed.world_id !== target.world_id || parsed.world_instance_id !== target.world_instance_id || parsed.manifest_digest !== target.manifest_digest) return undefined; const expected = hmac(secret, [issuer, target.principal, target.actor, target.run_id, target.world_id, target.world_instance_id, target.manifest_digest, String(parsed.after)]); return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(parsed.proof, "hex")) ? parsed.after : undefined; };
  const reserve = (input: unknown): void => {
    const values = own(input, ["bindings"], true); const parsed = values === undefined ? undefined : array(values.bindings, capacity, 1)?.map(binding);
    if (parsed === undefined || parsed.some((item) => item === undefined) || bindings.size !== 0 || admitted !== 0 || new Set(parsed.map((item) => item!.principal)).size !== parsed.length) return invalid();
    for (const item of parsed as LedgerBinding[]) { bindings.set(item.principal, item); entries.set(item.principal, []); pages.set(item.principal, 0); evicted.set(item.principal, 0); }
  };
  const append = (input: unknown): void => {
    const source = own(input, ["principal", "result", "declared_rejection_codes"]), result = source === undefined ? undefined : parseWorldActionResult(source.result), declared = source === undefined ? undefined : codes(source.declared_rejection_codes);
    if (live !== undefined || source === undefined || !text(source.principal) || result === undefined || declared === undefined || admitted >= MAX_ENTRIES || !bound(result, source.principal, declared) || !ACT.test(result.receipt_id) || !DECISION.test(result.decision_id) || resultIds.has(result.result_id) || receiptIds.has(result.receipt_id) || decisionIds.has(result.decision_id) || actionSequences.has(result.action_sequence) || result.action_sequence <= previousAction) return invalid();
    const resultNumber = numberSuffix(result.result_id, RESULT); const ids = result.status === "applied" ? result.caused_effect_ids.map((id) => numberSuffix(id, EFFECT)) : [];
    const effectHigh = Math.max(0, ...(ids as number[]));
    if (resultNumber === undefined || resultNumber < nextResult || resultNumber >= MAX_NEXT_COUNTER || ids.some((id) => id === undefined || id! < nextEffect) || effectHigh >= MAX_NEXT_COUNTER) return invalid();
    const effectWatermark = Math.max(effectWatermarks.at(-1) ?? 0, effectHigh);
    add(source.principal, result, effectWatermark); nextResult = Math.max(nextResult, resultNumber + 1); nextEffect = effectWatermark + 1;
  };
  const reserveBatch = (input: unknown): WorldActionResultBatchReservation => {
    const source = own(input, ["actions", "effect_capacity"], true), raw = source === undefined ? undefined : array(source.actions, MAX_ENTRIES, 1);
    if (live !== undefined || source === undefined || raw === undefined || !safe(source.effect_capacity, 0, DYNAMICS_LIMITS.events_per_tick) || admitted > MAX_ENTRIES - raw.length || nextResult > MAX_NEXT_COUNTER - raw.length || nextEffect > MAX_NEXT_COUNTER - source.effect_capacity) return invalid();
    const actions = raw.map((item) => { const record = own(item, ["principal", "receipt_id", "decision_id", "action_sequence", "declared_rejection_codes"]); const declared = record === undefined ? undefined : codes(record.declared_rejection_codes); return record === undefined || declared === undefined || !text(record.principal) || typeof record.receipt_id !== "string" || !ACT.test(record.receipt_id) || typeof record.decision_id !== "string" || !DECISION.test(record.decision_id) || !safe(record.action_sequence, 1) || record.receipt_id !== `world-act-${record.action_sequence}` ? undefined : frozen({ principal: record.principal, receipt_id: record.receipt_id, decision_id: record.decision_id, action_sequence: record.action_sequence, codes: declared }); });
    if (actions.some((item) => item === undefined) || new Set(actions.map((item) => item!.receipt_id)).size !== actions.length || new Set(actions.map((item) => item!.decision_id)).size !== actions.length || new Set(actions.map((item) => item!.action_sequence)).size !== actions.length || actions.some((item, index) => bindings.get(item!.principal) === undefined || receiptIds.has(item!.receipt_id) || decisionIds.has(item!.decision_id) || actionSequences.has(item!.action_sequence) || item!.action_sequence <= previousAction || (index > 0 && item!.action_sequence <= actions[index - 1]!.action_sequence))) return invalid();
    const reservation = { actions: frozen(actions as NonNullable<typeof actions[number]>[]), effectCapacity: source.effect_capacity, resultStart: nextResult, effectStart: nextEffect }; live = reservation;
    let settled = false;
    const stale = (): never => { throw new Error("stale world action result reservation"); };
    const resultId = (index: number): string => !settled && safe(index, 0, reservation.actions.length - 1) ? `world-result-${reservation.resultStart + index}` : stale();
    const effectId = (index: number): string => !settled && safe(index, 0, reservation.effectCapacity - 1) ? `world-effect-${reservation.effectStart + index}` : stale();
    const abort = (): void => { if (settled) stale(); settled = true; live = undefined; };
    const publish = (results: readonly WorldActionResult[]): void => {
      if (settled || !Array.isArray(results) || results.length !== reservation.actions.length) stale();
      const effects: string[] = [];
      for (let index = 0; index < results.length; index += 1) { const action = reservation.actions[index]!, result = parseWorldActionResult(results[index]) ?? stale(); if (result.result_id !== resultId(index) || result.receipt_id !== action.receipt_id || result.decision_id !== action.decision_id || result.action_sequence !== action.action_sequence || !bound(result, action.principal, action.codes) || resultIds.has(result.result_id) || receiptIds.has(result.receipt_id) || decisionIds.has(result.decision_id) || actionSequences.has(result.action_sequence)) stale(); if (result.status === "applied") for (const id of result.caused_effect_ids) if (!effects.includes(id)) effects.push(id); }
      const effectNumbers = effects.map((id) => numberSuffix(id, EFFECT));
      if (effects.length > reservation.effectCapacity || effectNumbers.some((id) => id === undefined)
        || new Set(effectNumbers).size !== effectNumbers.length
        || effectNumbers.sort((left, right) => left! - right!).some((id, index) => id !== reservation.effectStart + index)) stale();
      const effectWatermark = reservation.effectStart + effects.length - 1;
      for (let index = 0; index < results.length; index += 1) add(reservation.actions[index]!.principal, results[index]!, effectWatermark);
      nextResult = reservation.resultStart + results.length; nextEffect = reservation.effectStart + effects.length; settled = true; live = undefined;
    };
    return frozen({ resultId, effectId, publish, abort });
  };
  const read = (principal: string, request: unknown): WorldActionResultPage => { const target = text(principal) ? bindings.get(principal) : undefined, parsed = parseWorldActionResultPageRequest(request); if (target === undefined || parsed === undefined) return denied(); const after = parsed.result_after === undefined ? undefined : parseCursor(parsed.result_after, target); if (parsed.result_after !== undefined && after === undefined || after !== undefined && (after > pages.get(principal)! || after < evicted.get(principal)!)) return denied(); const values = entries.get(principal)!.filter((entry) => after === undefined || entry.page > after).slice(0, parsed.limit), next = values.at(-1)?.page ?? after; return frozen({ results: frozen(values.map((entry) => clone(entry.result))), ...(next === undefined ? {} : { next_result_after: makeCursor(target, next) }) }); };
  const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
  const exportState = (): LedgerSnapshotState => { if (live !== undefined) return invalid(); const ordered = [...bindings.values()].sort((left, right) => compare(left.principal, right.principal)); const numeric = (expression: RegExp) => (left: string, right: string) => numberSuffix(left, expression)! - numberSuffix(right, expression)!; return frozen({ version: WORLD_ACTION_RESULT_LEDGER_SNAPSHOT_VERSION, max_entries: maximum, max_principals: capacity, issuer, secret: secret.toString("hex"), bindings: frozen(ordered.map((item) => frozen({ ...item }))), entries: frozen(ordered.map((item) => frozen({ principal: item.principal, values: frozen(entries.get(item.principal)!.map((entry) => frozen({ page: entry.page, result: clone(entry.result) }))) }))), pages: frozen(ordered.map((item) => frozen([item.principal, pages.get(item.principal)!] as [string, number]))), evicted: frozen(ordered.map((item) => frozen([item.principal, evicted.get(item.principal)!] as [string, number]))), result_ids: frozen([...resultIds].sort(numeric(RESULT))), receipt_ids: frozen([...receiptIds].sort(numeric(ACT))), decision_ids: frozen([...decisionIds].sort(compare)), action_sequences: frozen([...actionSequences].sort((left, right) => left - right)), effect_watermarks: frozen([...effectWatermarks]), admitted, previous_action: previousAction, next_result: nextResult, next_effect: nextEffect }); };
  const importState = (state: LedgerSnapshotState): void => { if (restoreUsed || live !== undefined || bindings.size !== 0 || admitted !== 0 || state.version !== WORLD_ACTION_RESULT_LEDGER_SNAPSHOT_VERSION || state.max_entries !== maximum || state.max_principals !== capacity) return invalid(); bindings = new Map(state.bindings.map((item) => [item.principal, item])); entries = new Map(state.entries.map((item) => [item.principal, [...item.values]])); pages = new Map(state.pages); evicted = new Map(state.evicted); resultIds = new Set(state.result_ids); receiptIds = new Set(state.receipt_ids); decisionIds = new Set(state.decision_ids); actionSequences = new Set(state.action_sequences); effectWatermarks = [...state.effect_watermarks]; issuer = state.issuer; secret = Buffer.from(state.secret, "hex"); admitted = state.admitted; previousAction = state.previous_action; nextResult = state.next_result; nextEffect = state.next_effect; restoreUsed = true; };
  const authority = frozen({ append, read, reserve, reserveBatch, exportState, importState, hasLiveReservation: () => live !== undefined }); const ledger: WorldActionResultLedger = frozen({ read }); issued.set(ledger, authority); return ledger;
};
