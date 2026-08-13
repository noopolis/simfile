import { types } from "node:util";

import {
  readWorldActionResultLedger, WORLD_ACTION_RESULT_LEDGER_SNAPSHOT_VERSION as SNAPSHOT_VERSION,
  type LedgerBinding, type LedgerEntry, type LedgerSnapshotState, type WorldActionResultLedger,
} from "./actionResultLedger.js";
import { parseWorldActionResult, type WorldActionResult } from "./actionResult.js";

export const WORLD_ACTION_RESULT_LEDGER_SNAPSHOT_VERSION = SNAPSHOT_VERSION;
const MAX_RECORDS = 10_000, MAX_PRINCIPALS = 4_096;
const MAX_NEXT_COUNTER = Number.MAX_SAFE_INTEGER - 1, MAX_EFFECTS = 256;
const RESULT = /^world-result-([1-9][0-9]*)$/u, ACT = /^world-act-([1-9][0-9]*)$/u, DECISION = /^decision-([0-9]{12})$/u, EFFECT = /^world-effect-([1-9][0-9]*)$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u, ADDRESS = /^world:\/\/(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/)+entity\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const frozen = <T>(value: T): T => Object.freeze(value);
const fail = (): never => { throw new TypeError("invalid action result ledger snapshot"); };
const safe = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && value === value.trim();
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const suffix = (value: string, expression: RegExp): number | undefined => { const match = expression.exec(value); const valueNumber = match === null ? Number.NaN : Number(match[1]); return safe(valueNumber, 1) ? valueNumber : undefined; };
type Seen = Set<object>;

const claim = (value: unknown, seen: Seen): void => {
  if (value === null || typeof value !== "object" || types.isProxy(value) || seen.has(value)) fail();
  seen.add(value as object);
  if (Object.getOwnPropertyDescriptor(value as object, "then") !== undefined) fail();
};
const object = (value: unknown, fields: readonly string[], seen: Seen, claimed = false): Record<string, unknown> => {
  if (!claimed) claim(value, seen); if (Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail();
  const source = value as object, keys = Reflect.ownKeys(source); if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) fail();
  const output: Record<string, unknown> = Object.create(null);
  for (const key of fields) { const descriptor = Object.getOwnPropertyDescriptor(source, key); output[key] = descriptor?.enumerable && "value" in descriptor ? descriptor.value : fail(); }
  return output;
};
/** Claims retained values before global admission is known; do not inspect elements. */
const retainedValuesShape = (value: unknown, max: number, seen: Seen): number => {
  claim(value, seen); if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail();
  const length = Object.getOwnPropertyDescriptor(value as object, "length")?.value;
  if (!safe(length, 0, max)) fail();
  return length;
};
const denseArray = (value: unknown, length: number): void => {
  const source = value as object, keys = Reflect.ownKeys(source);
  if (keys.length !== length + 1) fail();
  for (let index = 0; index < length; index += 1) { const descriptor = Object.getOwnPropertyDescriptor(source, String(index)); if (!descriptor?.enumerable || !("value" in descriptor)) fail(); }
};
const arrayShape = (value: unknown, max: number, seen: Seen): number => {
  const length = retainedValuesShape(value, max, seen); denseArray(value, length); return length;
};
/** Reads a previously shape-checked array only after its exact cap is known. */
const list = (value: unknown, max: number, seen: Seen, claimed = false): readonly unknown[] => {
  const length = claimed ? Object.getOwnPropertyDescriptor(value as object, "length")?.value : arrayShape(value, max, seen);
  if (length > max) fail();
  if (claimed) denseArray(value, length);
  const source = value as unknown[];
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) output.push(Object.getOwnPropertyDescriptor(source, String(index))!.value);
  return output;
};
/** Copies only the public result schema; hostile extras are rejected before descent. */
const resultCopy = (value: unknown, seen: Seen): WorldActionResult => {
  claim(value, seen); if (Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail();
  const keys = Reflect.ownKeys(value as object); if (keys.length !== 10 || keys.some((key) => typeof key !== "string")) fail();
  const status = Object.getOwnPropertyDescriptor(value as object, "status"), statusValue = status?.value;
  if (!status?.enumerable || !("value" in status) || (statusValue !== "applied" && statusValue !== "rejected_at_mechanics")) fail();
  const source = object(value, statusValue === "applied" ? ["version", "result_id", "receipt_id", "decision_id", "actor", "action_sequence", "apply_tick", "status", "caused_effect_ids", "identity"] : ["version", "result_id", "receipt_id", "decision_id", "actor", "action_sequence", "apply_tick", "status", "rejection_code", "identity"], seen, true);
  const identity = object(source.identity, ["run_id", "world_id", "world_instance_id", "manifest_digest", "state_version"], seen);
  const base = { version: source.version, result_id: source.result_id, receipt_id: source.receipt_id, decision_id: source.decision_id, actor: source.actor, action_sequence: source.action_sequence, apply_tick: source.apply_tick, status: source.status, identity: frozen({ ...identity }) };
  if (source.status === "applied") {
    const effects = list(source.caused_effect_ids, MAX_EFFECTS, seen);
    if (!effects.every((effect) => typeof effect === "string")) fail();
    return parseWorldActionResult(frozen({ ...base, status: "applied" as const, caused_effect_ids: frozen([...effects] as string[]) })) ?? fail();
  }
  return parseWorldActionResult(frozen({ ...base, status: "rejected_at_mechanics" as const, rejection_code: source.rejection_code })) ?? fail();
};
const binding = (value: unknown, seen: Seen): LedgerBinding => {
  const source = object(value, ["principal", "actor", "run_id", "world_id", "world_instance_id", "manifest_digest"], seen);
  if (!text(source.principal) || typeof source.actor !== "string" || !ADDRESS.test(source.actor) || !text(source.run_id) || !text(source.world_id) || !text(source.world_instance_id) || typeof source.manifest_digest !== "string" || !SHA256.test(source.manifest_digest) || !source.actor.startsWith(`world://${source.world_id}/entity/`)) fail();
  return frozen({ principal: source.principal as string, actor: source.actor as string, run_id: source.run_id as string, world_id: source.world_id as string, world_instance_id: source.world_instance_id as string, manifest_digest: source.manifest_digest as string });
};
const pair = (value: unknown, seen: Seen, admitted: number): readonly [string, number] => { const values = list(value, 2, seen); return values.length === 2 && typeof values[0] === "string" && safe(values[1], 0, admitted) ? frozen([values[0], values[1]]) : fail(); };
const ids = (value: unknown, expression: RegExp, count: number, seen: Seen): readonly string[] => { const values = list(value, MAX_RECORDS, seen); if (values.length !== count || !values.every((item) => typeof item === "string" && expression.test(item))) fail(); const parsed = values.map((item) => suffix(item as string, expression)); if (parsed.some((item) => item === undefined) || new Set(values).size !== values.length || parsed.some((item, index) => index > 0 && item! <= parsed[index - 1]!)) fail(); return frozen([...values] as string[]); };
const sequences = (value: unknown, count: number, seen: Seen): readonly number[] => { const values = list(value, MAX_RECORDS, seen); if (values.length !== count || !values.every((item) => safe(item, 1)) || new Set(values).size !== values.length || values.some((item, index) => index > 0 && item <= values[index - 1]!)) fail(); return frozen([...values] as number[]); };
const watermarks = (value: unknown, count: number, seen: Seen): readonly number[] => { const values = list(value, MAX_RECORDS, seen); if (values.length !== count || !values.every((item) => safe(item, 0, MAX_NEXT_COUNTER - 1)) || values.some((item, index) => index > 0 && item < values[index - 1]!)) fail(); return frozen([...values] as number[]); };

/** Parses bounded parts independently; no whole-snapshot JSON budget limits reachable state. */
export const parseWorldActionResultLedgerSnapshot = (input: unknown): LedgerSnapshotState => {
  const seen: Seen = new Set();
  try {
    const source = object(input, ["version", "max_entries", "max_principals", "issuer", "secret", "bindings", "entries", "pages", "evicted", "result_ids", "receipt_ids", "decision_ids", "action_sequences", "effect_watermarks", "admitted", "previous_action", "next_result", "next_effect"], seen);
    if (source.version !== SNAPSHOT_VERSION || !safe(source.max_entries, 1, MAX_RECORDS) || !safe(source.max_principals, 1, MAX_PRINCIPALS) || typeof source.issuer !== "string" || !/^[a-f0-9]{32}$/u.test(source.issuer) || typeof source.secret !== "string" || !/^[a-f0-9]{64}$/u.test(source.secret) || !safe(source.admitted, 0, MAX_RECORDS) || !safe(source.previous_action, 0) || !safe(source.next_result, 1, MAX_NEXT_COUNTER) || !safe(source.next_effect, 1, MAX_NEXT_COUNTER)) fail();
    const maxEntries = source.max_entries as number, admitted = source.admitted as number, bindings = list(source.bindings, source.max_principals as number, seen).map((item) => binding(item, seen));
    const rawEntries = list(source.entries, source.max_principals as number, seen), pages = list(source.pages, source.max_principals as number, seen).map((item) => pair(item, seen, admitted)), evicted = list(source.evicted, source.max_principals as number, seen).map((item) => pair(item, seen, admitted));
    if (bindings.length !== rawEntries.length || bindings.length !== pages.length || bindings.length !== evicted.length || new Set(bindings.map((item) => item.principal)).size !== bindings.length || bindings.some((item, index) => index > 0 && compare(item.principal, bindings[index - 1]!.principal) <= 0)) fail();
    const retained = rawEntries.map((raw, index) => {
      const item = object(raw, ["principal", "values"], seen), target = bindings[index]!, page = pages[index]!, frontier = evicted[index]!;
      const expected = page[1] - frontier[1], length = retainedValuesShape(item.values, maxEntries, seen);
      if (item.principal !== target.principal || page[0] !== target.principal || frontier[0] !== target.principal || frontier[1] > page[1] || length !== expected) fail();
      return { principal: target.principal, raw: item.values, expected, page, frontier };
    });
    let pageTotal = 0;
    for (const page of pages) { if (page[1] > admitted - pageTotal) fail(); pageTotal += page[1]; }
    let retainedTotal = 0;
    for (const item of retained) { if (item.expected > admitted - retainedTotal) fail(); retainedTotal += item.expected; }
    const entries: Array<Readonly<{ principal: string; values: readonly LedgerEntry[] }>> = [], retainedResults = new Set<string>(), retainedReceipts = new Set<string>(), retainedDecisions = new Set<string>(), retainedActions = new Set<number>();
    for (let index = 0; index < bindings.length; index += 1) {
      const target = bindings[index]!, current = retained[index]!, page = current.page, frontier = current.frontier; denseArray(current.raw, current.expected); const values = list(current.raw, current.expected, seen, true); let previous = frontier[1]; const parsed: LedgerEntry[] = [];
      if (values.length !== current.expected) fail(); for (const item of values) {
        const entry = object(item, ["page", "result"], seen), itemResult = resultCopy(entry.result, seen), entryPage = entry.page;
        if (!safe(entryPage, 1, admitted) || itemResult === undefined) fail(); const result = itemResult as WorldActionResult, number = entryPage as number;
        if (number !== previous + 1 || number > page[1] || result.actor !== target.actor || result.identity.run_id !== target.run_id || result.identity.world_id !== target.world_id || result.identity.world_instance_id !== target.world_instance_id || result.identity.manifest_digest !== target.manifest_digest || retainedResults.has(result.result_id) || retainedReceipts.has(result.receipt_id) || retainedDecisions.has(result.decision_id) || retainedActions.has(result.action_sequence)) fail();
        previous = number; retainedResults.add(result.result_id); retainedReceipts.add(result.receipt_id); retainedDecisions.add(result.decision_id); retainedActions.add(result.action_sequence);
        parsed.push(frozen({ page: number, result }));
      }
      entries.push(frozen({ principal: target.principal, values: frozen(parsed) }));
    }
    const resultIds = ids(source.result_ids, RESULT, admitted, seen), receiptIds = ids(source.receipt_ids, ACT, admitted, seen), decisionIds = ids(source.decision_ids, DECISION, admitted, seen), actionSequences = sequences(source.action_sequences, admitted, seen), effectWatermarks = watermarks(source.effect_watermarks, admitted, seen), lastResult = suffix(resultIds.at(-1) ?? "world-result-0", RESULT) ?? 0;
    if (lastResult >= MAX_NEXT_COUNTER) fail();
    const expectedResult = lastResult + 1, expectedEffect = (effectWatermarks.at(-1) ?? 0) + 1, watermarkByResult = new Map(resultIds.map((id, index) => [id, effectWatermarks[index]! ]));
    if (pageTotal !== admitted || source.previous_action !== (actionSequences.at(-1) ?? 0) || receiptIds.some((id, index) => suffix(id, ACT) !== actionSequences[index]) || ![...retainedResults].every((id) => resultIds.includes(id)) || ![...retainedReceipts].every((id) => receiptIds.includes(id)) || ![...retainedDecisions].every((id) => decisionIds.includes(id)) || ![...retainedActions].every((id) => actionSequences.includes(id)) || source.next_result !== expectedResult || source.next_effect !== expectedEffect || entries.some((entry) => entry.values.some(({ result }) => result.status === "applied" && result.caused_effect_ids.some((effect) => suffix(effect, EFFECT)! > watermarkByResult.get(result.result_id)!)))) fail();
    return frozen({ version: SNAPSHOT_VERSION, max_entries: maxEntries, max_principals: source.max_principals as number, issuer: source.issuer as string, secret: source.secret as string, bindings: frozen(bindings), entries: frozen(entries), pages: frozen(pages), evicted: frozen(evicted), result_ids: resultIds, receipt_ids: receiptIds, decision_ids: decisionIds, action_sequences: actionSequences, effect_watermarks: effectWatermarks, admitted, previous_action: source.previous_action as number, next_result: source.next_result as number, next_effect: source.next_effect as number });
  } catch { return fail(); }
};
export const snapshotWorldActionResultStore = (ledger: WorldActionResultLedger): unknown => { const authority = readWorldActionResultLedger(ledger); if (authority === undefined || authority.hasLiveReservation()) fail(); return parseWorldActionResultLedgerSnapshot(authority!.exportState()); };
export const restoreWorldActionResultStore = (ledger: WorldActionResultLedger, snapshot: unknown): void => { const authority = readWorldActionResultLedger(ledger); if (authority === undefined) fail(); authority!.importState(parseWorldActionResultLedgerSnapshot(snapshot)); };
