import assert from "node:assert/strict";
import test from "node:test";
import { createWorldActionResultLedger, readWorldActionResultLedger, WORLD_ACTION_RESULT_PAGE_REQUEST_VERSION } from "./actionResultLedger.js";
import { parseWorldActionResultLedgerSnapshot, restoreWorldActionResultStore, snapshotWorldActionResultStore } from "./actionResultLedgerSnapshot.js";

const binding = Object.freeze({ principal: "p", actor: "world://world/entity/p", run_id: "run", world_id: "world", world_instance_id: "instance", manifest_digest: `sha256:${"a".repeat(64)}` });
const result = Object.freeze({ version: "simfile.world-action-result.v1" as const, result_id: "world-result-1", receipt_id: "world-act-1", decision_id: "decision-000000000001", actor: binding.actor, action_sequence: 1, apply_tick: 0, status: "applied" as const, caused_effect_ids: Object.freeze(["world-effect-1"]), identity: Object.freeze({ run_id: binding.run_id, world_id: binding.world_id, world_instance_id: binding.world_instance_id, manifest_digest: binding.manifest_digest, state_version: 2 }) });
const request = (result_after?: unknown) => ({ version: WORLD_ACTION_RESULT_PAGE_REQUEST_VERSION, ...(result_after === undefined ? {} : { result_after }) });

test("round-trips standalone state and keeps pre-snapshot cursors valid", () => {
  const source = createWorldActionResultLedger(); const writer = readWorldActionResultLedger(source)!; writer.reserve({ bindings: [binding] }); writer.append({ principal: "p", result }); const cursor = source.read("p", request()).next_result_after!;
  const snapshot = snapshotWorldActionResultStore(source); const restored = createWorldActionResultLedger(); restoreWorldActionResultStore(restored, snapshot);
  assert.equal(restored.read("p", request(cursor)).results.length, 0); assert.throws(() => restoreWorldActionResultStore(restored, snapshot));
  const hostile = { ...(snapshot as Record<string, unknown>), secret: "0" }; assert.throws(() => restoreWorldActionResultStore(createWorldActionResultLedger(), hostile));
  assert.throws(() => restoreWorldActionResultStore(createWorldActionResultLedger({ maxEntriesPerPrincipal: 1 }), snapshot));
});

test("rejects detached hostile snapshot graphs without consuming a pristine restore", () => {
  const source = createWorldActionResultLedger(); const writer = readWorldActionResultLedger(source)!; writer.reserve({ bindings: [binding] }); writer.append({ principal: "p", result });
  const snapshot = snapshotWorldActionResultStore(source) as Record<string, unknown>;
  const accessor = { ...snapshot }; Object.defineProperty(accessor, "secret", { enumerable: true, get: () => { throw new Error("read"); } });
  const alias = structuredClone(snapshot) as Record<string, unknown>; alias.entries = alias.bindings;
  const sparse = structuredClone(snapshot) as Record<string, unknown>; const ids = sparse.result_ids as unknown[]; ids.length = 2;
  for (const hostile of [accessor, new Proxy(snapshot, {}), alias, sparse, { ...snapshot, next_result: 1 }]) {
    const target = createWorldActionResultLedger(); assert.throws(() => restoreWorldActionResultStore(target, hostile));
    restoreWorldActionResultStore(target, snapshot); assert.equal(target.read("p", request()).results.length, 1);
  }
  assert.ok(Object.isFrozen(parseWorldActionResultLedgerSnapshot(snapshot)));
});

test("preflights cumulative retained lengths before reading numeric elements", () => {
  const q = { ...binding, principal: "q", actor: "world://world/entity/q" };
  const source = createWorldActionResultLedger({ maxEntriesPerPrincipal: 6_000, maxPrincipals: 2 });
  const writer = readWorldActionResultLedger(source)!; writer.reserve({ bindings: [binding, q] });
  for (let index = 1; index <= 6_000; index += 1) writer.append({ principal: index % 2 === 0 ? "q" : "p", result: { ...result, actor: index % 2 === 0 ? q.actor : binding.actor, result_id: `world-result-${index}`, receipt_id: `world-act-${index}`, decision_id: `decision-${String(index).padStart(12, "0")}`, action_sequence: index, caused_effect_ids: [] } });
  const snapshot = structuredClone(snapshotWorldActionResultStore(source)) as Record<string, unknown>;
  snapshot.admitted = 5_999;
  const entries = snapshot.entries as Array<{ values: unknown[] }>;
  let read = 0; const values = entries[0]!.values as unknown[], first = values[0];
  Object.defineProperty(values, "0", { enumerable: true, get: () => { read += 1; return first; } });
  const original = Object.getOwnPropertyDescriptor; let numericDescriptors = 0;
  (Object as { getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor }).getOwnPropertyDescriptor = (target, key) => {
    if (target === values && key === "0") numericDescriptors += 1;
    return original(target, key);
  };
  try { assert.throws(() => parseWorldActionResultLedgerSnapshot(snapshot)); }
  finally { (Object as { getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor }).getOwnPropertyDescriptor = original; }
  assert.equal(read, 0); assert.equal(numericDescriptors, 0);
});

test("rejects dense-list extras, holes, and accessors before a pristine restore", () => {
  const source = createWorldActionResultLedger(); const writer = readWorldActionResultLedger(source)!; writer.reserve({ bindings: [binding] }); writer.append({ principal: "p", result });
  const pristine = snapshotWorldActionResultStore(source) as Record<string, unknown>;
  const hostile = [
    () => { const value = structuredClone(pristine) as Record<string, unknown>; Object.defineProperty(value.result_ids as object, Symbol("extra"), { value: 1 }); return value; },
    () => { const value = structuredClone(pristine) as Record<string, unknown>; delete (value.bindings as unknown[])[0]; return value; },
  ];
  for (const make of hostile) { const target = createWorldActionResultLedger(); assert.throws(() => restoreWorldActionResultStore(target, make())); restoreWorldActionResultStore(target, pristine); assert.equal(target.read("p", request()).results.length, 1); }
  const accessor = structuredClone(pristine) as Record<string, unknown>; let reads = 0;
  Object.defineProperty(accessor.pages as object, "0", { enumerable: true, get: () => { reads += 1; return ["p", 1]; } });
  const target = createWorldActionResultLedger(); assert.throws(() => restoreWorldActionResultStore(target, accessor)); assert.equal(reads, 0); restoreWorldActionResultStore(target, pristine); assert.equal(target.read("p", request()).results.length, 1);
});

test("keeps result and effect counters at their safe exhausted boundary", () => {
  const ceiling = Number.MAX_SAFE_INTEGER - 1, last = ceiling - 1;
  for (const [kind, accepted, rejected, key] of [
    ["result", { ...result, result_id: `world-result-${last}`, caused_effect_ids: ["world-effect-1"] }, { ...result, result_id: `world-result-${ceiling}`, receipt_id: "world-act-2", decision_id: "decision-000000000002", action_sequence: 2, caused_effect_ids: ["world-effect-2"] }, "next_result"],
    ["effect", { ...result, caused_effect_ids: [`world-effect-${last}`] }, { ...result, result_id: "world-result-2", receipt_id: "world-act-2", decision_id: "decision-000000000002", action_sequence: 2, caused_effect_ids: [`world-effect-${ceiling}`] }, "next_effect"],
  ] as const) {
    const source = createWorldActionResultLedger(), writer = readWorldActionResultLedger(source)!; writer.reserve({ bindings: [binding] }); writer.append({ principal: "p", result: accepted });
    const snapshot = snapshotWorldActionResultStore(source) as Record<string, unknown>; assert.equal(snapshot[key], ceiling); assert.doesNotThrow(() => parseWorldActionResultLedgerSnapshot(snapshot));
    const restored = createWorldActionResultLedger(); restoreWorldActionResultStore(restored, snapshot); const next = readWorldActionResultLedger(restored)!, before = snapshotWorldActionResultStore(restored), visible = restored.read("p", request()).results;
    assert.equal(visible[0]!.result_id, accepted.result_id); assert.deepEqual(visible[0]!.status === "applied" ? visible[0]!.caused_effect_ids : [], accepted.caused_effect_ids);
    assert.throws(() => next.append({ principal: "p", result: rejected }), kind); assert.deepEqual(snapshotWorldActionResultStore(restored), before);
    assert.throws(() => next.reserveBatch({ actions: [{ principal: "p", receipt_id: "world-act-2", decision_id: "decision-000000000002", action_sequence: 2, declared_rejection_codes: [] }], effect_capacity: 1 }), kind);
    assert.deepEqual(snapshotWorldActionResultStore(restored), before); assert.deepEqual(restored.read("p", request()).results, visible); assert.doesNotThrow(() => snapshotWorldActionResultStore(restored));
  }
});

test("keeps evicted effect high water and rejects hostile watermark evidence", () => {
  const source = createWorldActionResultLedger({ maxEntriesPerPrincipal: 1 }), writer = readWorldActionResultLedger(source)!; writer.reserve({ bindings: [binding] });
  const rejected = (({ caused_effect_ids: _effects, ...value }) => ({ ...value, result_id: "world-result-2", receipt_id: "world-act-2", decision_id: "decision-000000000002", action_sequence: 2, status: "rejected_at_mechanics" as const, rejection_code: "world_action_rejected" }))(result);
  writer.append({ principal: "p", result: { ...result, caused_effect_ids: ["world-effect-100"] } }); writer.append({ principal: "p", result: rejected });
  const pristine = snapshotWorldActionResultStore(source) as Record<string, unknown>; assert.deepEqual(pristine.effect_watermarks, [100, 100]); assert.equal(pristine.next_effect, 101);
  const target = createWorldActionResultLedger({ maxEntriesPerPrincipal: 1 }), rollback = structuredClone(pristine) as Record<string, unknown>; rollback.next_effect = 1;
  assert.throws(() => restoreWorldActionResultStore(target, rollback)); restoreWorldActionResultStore(target, pristine);
  const next = readWorldActionResultLedger(target)!, batch = next.reserveBatch({ actions: [{ principal: "p", receipt_id: "world-act-3", decision_id: "decision-000000000003", action_sequence: 3, declared_rejection_codes: [] }], effect_capacity: 100 });
  assert.equal(batch.effectId(0), "world-effect-101"); batch.publish([{ ...result, result_id: batch.resultId(0), receipt_id: "world-act-3", decision_id: "decision-000000000003", action_sequence: 3, caused_effect_ids: Array.from({ length: 100 }, (_, index) => batch.effectId(index)) }]);
  const hostile = (change: (value: Record<string, unknown>) => void): void => { const value = structuredClone(pristine) as Record<string, unknown>; change(value); const fresh = createWorldActionResultLedger({ maxEntriesPerPrincipal: 1 }); assert.throws(() => restoreWorldActionResultStore(fresh, value)); restoreWorldActionResultStore(fresh, pristine); };
  hostile((x) => { (x.effect_watermarks as unknown[]).pop(); }); hostile((x) => { (x.effect_watermarks as unknown[]).push(100); }); hostile((x) => { delete (x.effect_watermarks as unknown[])[0]; });
  hostile((x) => { Object.defineProperty(x.effect_watermarks as object, "0", { enumerable: true, get: () => 100 }); }); hostile((x) => { Object.defineProperty(x.effect_watermarks as object, Symbol("x"), { value: 1 }); }); hostile((x) => { x.effect_watermarks = new Proxy(x.effect_watermarks as object, {}); }); hostile((x) => { Object.setPrototypeOf(x.effect_watermarks as object, {}); });
  hostile((x) => { x.effect_watermarks = [100, 99]; }); hostile((x) => { x.effect_watermarks = [100, 1.5]; }); hostile((x) => { x.effect_watermarks = [-1, 100]; }); hostile((x) => { x.effect_watermarks = [100, Number.MAX_SAFE_INTEGER - 1]; }); hostile((x) => { x.next_effect = 1; });
  const retained = createWorldActionResultLedger({ maxEntriesPerPrincipal: 2 }), retainedWriter = readWorldActionResultLedger(retained)!; retainedWriter.reserve({ bindings: [binding] }); retainedWriter.append({ principal: "p", result: { ...result, caused_effect_ids: ["world-effect-100"] } }); retainedWriter.append({ principal: "p", result: rejected });
  const retainedPristine = snapshotWorldActionResultStore(retained) as Record<string, unknown>, above = structuredClone(retainedPristine) as Record<string, unknown>; above.effect_watermarks = [99, 100]; const retainedTarget = createWorldActionResultLedger({ maxEntriesPerPrincipal: 2 }); assert.throws(() => restoreWorldActionResultStore(retainedTarget, above)); restoreWorldActionResultStore(retainedTarget, retainedPristine);
});

test("records append and shared-batch watermarks atomically", () => {
  const ledger = createWorldActionResultLedger(), writer = readWorldActionResultLedger(ledger)!; writer.reserve({ bindings: [binding] }); assert.deepEqual((snapshotWorldActionResultStore(ledger) as Record<string, unknown>).effect_watermarks, []); assert.equal((snapshotWorldActionResultStore(ledger) as Record<string, unknown>).next_effect, 1);
  const rejected = (({ caused_effect_ids: _effects, ...value }) => ({ ...value, result_id: "world-result-2", receipt_id: "world-act-2", decision_id: "decision-000000000002", action_sequence: 2, status: "rejected_at_mechanics" as const, rejection_code: "world_action_rejected" }))(result);
  writer.append({ principal: "p", result: { ...result, caused_effect_ids: ["world-effect-5"] } }); writer.append({ principal: "p", result: rejected });
  const actions = [3, 4].map((action_sequence) => ({ principal: "p", receipt_id: `world-act-${action_sequence}`, decision_id: `decision-${String(action_sequence).padStart(12, "0")}`, action_sequence, declared_rejection_codes: [] })); const batch = writer.reserveBatch({ actions, effect_capacity: 3 }), first = batch.effectId(0), second = batch.effectId(1);
  batch.publish([{ ...result, result_id: batch.resultId(0), receipt_id: "world-act-3", decision_id: "decision-000000000003", action_sequence: 3, caused_effect_ids: [first, second] }, { ...result, result_id: batch.resultId(1), receipt_id: "world-act-4", decision_id: "decision-000000000004", action_sequence: 4, caused_effect_ids: [second] }]);
  const before = snapshotWorldActionResultStore(ledger) as Record<string, unknown>; assert.deepEqual(before.effect_watermarks, [5, 5, 7, 7]); assert.equal(before.next_effect, 8);
  const restored = createWorldActionResultLedger(); restoreWorldActionResultStore(restored, before); assert.deepEqual((snapshotWorldActionResultStore(restored) as Record<string, unknown>).effect_watermarks, [5, 5, 7, 7]);
  assert.throws(() => writer.append({ principal: "p", result: { ...result, result_id: "world-result-5", receipt_id: "world-act-5", decision_id: "decision-000000000005", action_sequence: 5, caused_effect_ids: ["wrong"] } })); assert.deepEqual(snapshotWorldActionResultStore(ledger), before);
  const aborted = writer.reserveBatch({ actions: [{ principal: "p", receipt_id: "world-act-5", decision_id: "decision-000000000005", action_sequence: 5, declared_rejection_codes: [] }], effect_capacity: 1 }); aborted.abort(); assert.deepEqual(snapshotWorldActionResultStore(ledger), before);
  const failed = writer.reserveBatch({ actions: [{ principal: "p", receipt_id: "world-act-5", decision_id: "decision-000000000005", action_sequence: 5, declared_rejection_codes: [] }], effect_capacity: 1 }); assert.throws(() => failed.publish([])); assert.equal(failed.resultId(0), "world-result-5"); failed.abort(); assert.deepEqual(snapshotWorldActionResultStore(ledger), before);
});

test("rejects every nested hostile graph and restores the pristine snapshot afterward", () => {
  const source = createWorldActionResultLedger(); const writer = readWorldActionResultLedger(source)!; writer.reserve({ bindings: [binding] });
  writer.append({ principal: "p", result }); writer.append({ principal: "p", result: { ...result, result_id: "world-result-2", receipt_id: "world-act-2", decision_id: "decision-000000000002", action_sequence: 2, caused_effect_ids: ["world-effect-2"] } });
  const pristine = snapshotWorldActionResultStore(source) as Record<string, unknown>;
  const make = (): Record<string, unknown> => structuredClone(pristine) as Record<string, unknown>;
  const cases: Record<string, () => Record<string, unknown>> = {
    "shared identity alias": () => { const x = make(), values = (x.entries as Array<{ values: Array<{ result: Record<string, unknown> }> }>)[0]!.values; values[1]!.result.identity = values[0]!.result.identity; return x; },
    "shared caused_effect_ids alias": () => { const x = make(), values = (x.entries as Array<{ values: Array<{ result: Record<string, unknown> }> }>)[0]!.values; values[1]!.result.caused_effect_ids = values[0]!.result.caused_effect_ids; return x; },
    "own thenable": () => { const x = make(); Object.defineProperty(((x.entries as Array<{ values: Array<{ result: Record<string, unknown> }> }>)[0]!.values[0]!.result.identity), "then", { enumerable: true, value: () => {} }); return x; },
    "custom prototype": () => { const x = make(); Object.setPrototypeOf((x.entries as Array<{ values: unknown[] }>)[0]!.values[0], { }); return x; },
    "sparse nested array": () => { const x = make(), values = (x.entries as Array<{ values: unknown[] }>)[0]!.values; delete values[1]; return x; },
    "nested accessor": () => { const x = make(); Object.defineProperty((x.entries as Array<{ values: Array<{ result: Record<string, unknown> }> }>)[0]!.values[1]!.result, "actor", { enumerable: true, get: () => binding.actor }); return x; },
    "nested symbol key": () => { const x = make(); Object.defineProperty((x.entries as Array<{ values: unknown[] }>)[0]!.values[1], Symbol("hostile"), { value: 1 }); return x; },
    "nested proxy": () => { const x = make(), values = (x.entries as Array<{ values: unknown[] }>)[0]!.values; values[1] = new Proxy(values[1]!, {}); return x; },
  };
  for (const [name, hostile] of Object.entries(cases)) { const target = createWorldActionResultLedger(); assert.throws(() => restoreWorldActionResultStore(target, hostile()), name); restoreWorldActionResultStore(target, pristine); assert.equal(target.read("p", request()).results.length, 2); }
});

test("rejects a structurally aligned maximum-safe result suffix before consuming restore", () => {
  const source = createWorldActionResultLedger(); const writer = readWorldActionResultLedger(source)!; writer.reserve({ bindings: [binding] }); writer.append({ principal: "p", result });
  const pristine = snapshotWorldActionResultStore(source) as Record<string, unknown>;
  const hostile = structuredClone(pristine) as Record<string, unknown>, hostileId = `world-result-${Number.MAX_SAFE_INTEGER}`;
  (hostile.result_ids as unknown[])[0] = hostileId;
  (((hostile.entries as Array<{ values: Array<{ result: Record<string, unknown> }> }>)[0]!.values[0]!).result).result_id = hostileId;
  const target = createWorldActionResultLedger(); assert.throws(() => restoreWorldActionResultStore(target, hostile));
  restoreWorldActionResultStore(target, pristine); assert.equal(target.read("p", request()).results[0]!.result_id, "world-result-1");
});

test("rejects cumulative page totals before consuming a pristine restore", () => {
  const q = { ...binding, principal: "q", actor: "world://world/entity/q" };
  const source = createWorldActionResultLedger({ maxPrincipals: 2 }); const writer = readWorldActionResultLedger(source)!; writer.reserve({ bindings: [binding, q] });
  writer.append({ principal: "p", result }); writer.append({ principal: "q", result: { ...result, actor: q.actor, result_id: "world-result-2", receipt_id: "world-act-2", decision_id: "decision-000000000002", action_sequence: 2, caused_effect_ids: [] } });
  const pristine = snapshotWorldActionResultStore(source) as Record<string, unknown>, hostile = structuredClone(pristine) as Record<string, unknown>;
  hostile.admitted = 1;
  const target = createWorldActionResultLedger({ maxPrincipals: 2 }); assert.throws(() => restoreWorldActionResultStore(target, hostile));
  restoreWorldActionResultStore(target, pristine); assert.equal(target.read("p", request()).results.length, 1);
});

test("parses and restores an exact 10,000-record store while rejecting one-over arrays", () => {
  const source = createWorldActionResultLedger({ maxEntriesPerPrincipal: 10_000 }); const writer = readWorldActionResultLedger(source)!; writer.reserve({ bindings: [binding] });
  for (let index = 1; index <= 10_000; index += 1) writer.append({ principal: "p", result: { ...result, result_id: `world-result-${index}`, receipt_id: `world-act-${index}`, decision_id: `decision-${String(index).padStart(12, "0")}`, action_sequence: index, caused_effect_ids: [`world-effect-${index}`] } });
  const snapshot = snapshotWorldActionResultStore(source) as Record<string, unknown>; const restored = createWorldActionResultLedger({ maxEntriesPerPrincipal: 10_000 }); restoreWorldActionResultStore(restored, snapshot);
  assert.equal(restored.read("p", request()).results.length, 50);
  const oneOver = structuredClone(snapshot) as Record<string, unknown>; (oneOver.result_ids as unknown[]).push("world-result-10001"); assert.throws(() => parseWorldActionResultLedgerSnapshot(oneOver));
});

test("uses v1 snapshots without a global effect-id set and preserves custom configuration", () => {
  const source = createWorldActionResultLedger({ maxEntriesPerPrincipal: 2, maxPrincipals: 1 }); const writer = readWorldActionResultLedger(source)!; writer.reserve({ bindings: [binding] });
  writer.append({ principal: "p", result: { ...result, caused_effect_ids: Array.from({ length: 256 }, (_, index) => `world-effect-${index + 1}`) } });
  const snapshot = snapshotWorldActionResultStore(source) as Record<string, unknown>;
  assert.equal(snapshot.version, "simfile.world-action-result-ledger.v1"); assert.equal("effect_ids" in snapshot, false);
  const restored = createWorldActionResultLedger({ maxEntriesPerPrincipal: 2, maxPrincipals: 1 }); restoreWorldActionResultStore(restored, snapshot);
  assert.equal(restored.read("p", request()).results[0]!.status, "applied");
  assert.throws(() => restoreWorldActionResultStore(createWorldActionResultLedger({ maxEntriesPerPrincipal: 2, maxPrincipals: 2 }), snapshot));
});

test("rejects evicted receipt/action disagreement and does not consume a failed restore", () => {
  const source = createWorldActionResultLedger({ maxEntriesPerPrincipal: 1 }); const writer = readWorldActionResultLedger(source)!;
  writer.reserve({ bindings: [binding] }); writer.append({ principal: "p", result }); writer.append({ principal: "p", result: { ...result, result_id: "world-result-2", receipt_id: "world-act-2", decision_id: "decision-000000000002", action_sequence: 2, caused_effect_ids: ["world-effect-2"] } });
  const snapshot = snapshotWorldActionResultStore(source) as Record<string, unknown>, hostile = structuredClone(snapshot) as Record<string, unknown>;
  hostile.receipt_ids = ["world-act-2", "world-act-3"];
  const target = createWorldActionResultLedger({ maxEntriesPerPrincipal: 1 }); assert.throws(() => restoreWorldActionResultStore(target, hostile));
  restoreWorldActionResultStore(target, snapshot); assert.equal(target.read("p", request()).results[0]!.receipt_id, "world-act-2");
});

test("rejects an extra deep result before walking it", () => {
  const source = createWorldActionResultLedger(); const writer = readWorldActionResultLedger(source)!; writer.reserve({ bindings: [binding] }); writer.append({ principal: "p", result });
  const hostile = structuredClone(snapshotWorldActionResultStore(source)) as Record<string, unknown>;
  const raw = ((hostile.entries as Array<{ values: Array<{ result: Record<string, unknown> }> }>)[0]!.values[0]!.result); let touched = 0;
  Object.defineProperty(raw, "extra", { enumerable: true, get: () => { touched += 1; return { nested: raw }; } });
  assert.throws(() => parseWorldActionResultLedgerSnapshot(hostile)); assert.equal(touched, 0);
});

test("preflights retained value descriptors and cumulative admissions before values", () => {
  const source = createWorldActionResultLedger(); const writer = readWorldActionResultLedger(source)!; writer.reserve({ bindings: [binding] }); writer.append({ principal: "p", result });
  const snapshot = snapshotWorldActionResultStore(source) as Record<string, unknown>;
  const accessor = structuredClone(snapshot) as Record<string, unknown>, values = ((accessor.entries as Array<{ values: unknown[] }>)[0]!.values); let touched = 0;
  Object.defineProperty(values, "0", { enumerable: true, get: () => { touched += 1; return {}; } });
  assert.throws(() => parseWorldActionResultLedgerSnapshot(accessor)); assert.equal(touched, 0);
  const over = structuredClone(snapshot) as Record<string, unknown>; over.bindings = [binding, { ...binding, principal: "q", actor: "world://world/entity/q" }]; over.entries = [...(over.entries as unknown[]), { principal: "q", values: [] }]; over.pages = [...(over.pages as unknown[]), ["q", 1]]; over.evicted = [...(over.evicted as unknown[]), ["q", 1]];
  assert.throws(() => parseWorldActionResultLedgerSnapshot(over));
});

test("refuses a live batch snapshot, then aborts without an id gap", () => {
  const ledger = createWorldActionResultLedger(), writer = readWorldActionResultLedger(ledger)!; writer.reserve({ bindings: [binding] });
  const batch = writer.reserveBatch({ actions: [{ principal: "p", receipt_id: "world-act-1", decision_id: "decision-000000000001", action_sequence: 1, declared_rejection_codes: [] }], effect_capacity: 1 });
  assert.throws(() => snapshotWorldActionResultStore(ledger)); batch.abort(); assert.doesNotThrow(() => snapshotWorldActionResultStore(ledger));
  assert.equal(writer.reserveBatch({ actions: [{ principal: "p", receipt_id: "world-act-1", decision_id: "decision-000000000001", action_sequence: 1, declared_rejection_codes: [] }], effect_capacity: 1 }).resultId(0), "world-result-1");
});

test("restores independent evicted principals, global evidence, and high effect water", () => {
  const q = { ...binding, principal: "q", actor: "world://world/entity/q" }, source = createWorldActionResultLedger({ maxEntriesPerPrincipal: 1 }); const writer = readWorldActionResultLedger(source)!; writer.reserve({ bindings: [binding, q] });
  const one = result, two = { ...result, result_id: "world-result-2", receipt_id: "world-act-2", decision_id: "decision-000000000002", actor: q.actor, action_sequence: 2, caused_effect_ids: ["world-effect-50001"] }, three = { ...result, result_id: "world-result-3", receipt_id: "world-act-3", decision_id: "decision-000000000003", action_sequence: 3, caused_effect_ids: ["world-effect-50002"] };
  writer.append({ principal: "p", result: one }); writer.append({ principal: "q", result: two }); writer.append({ principal: "p", result: three }); const restored = createWorldActionResultLedger({ maxEntriesPerPrincipal: 1 }); restoreWorldActionResultStore(restored, snapshotWorldActionResultStore(source)); const next = readWorldActionResultLedger(restored)!;
  assert.deepEqual(restored.read("p", request()).results.map((item) => item.receipt_id), ["world-act-3"]); assert.deepEqual(restored.read("q", request()).results.map((item) => item.receipt_id), ["world-act-2"]);
  for (const duplicate of [{ ...three, result_id: one.result_id, receipt_id: "world-act-4", decision_id: "decision-000000000004", action_sequence: 4 }, { ...three, result_id: "world-result-4", receipt_id: one.receipt_id, decision_id: "decision-000000000004", action_sequence: 4 }, { ...three, result_id: "world-result-4", receipt_id: "world-act-4", decision_id: one.decision_id, action_sequence: 4 }, { ...three, result_id: "world-result-4", receipt_id: "world-act-3", decision_id: "decision-000000000004", action_sequence: 3 }]) assert.throws(() => next.append({ principal: "p", result: duplicate }));
  const batch = next.reserveBatch({ actions: [{ principal: "p", receipt_id: "world-act-4", decision_id: "decision-000000000004", action_sequence: 4, declared_rejection_codes: [] }], effect_capacity: 1 }); assert.equal(batch.effectId(0), "world-effect-50003"); batch.abort();
});

test("exports principals in deterministic UTF-16 order", () => {
  const first = { ...binding, principal: "Ω" }, second = { ...binding, principal: "é", actor: "world://world/entity/e" }, ledger = createWorldActionResultLedger(); const writer = readWorldActionResultLedger(ledger)!; writer.reserve({ bindings: [first, second] });
  assert.deepEqual((snapshotWorldActionResultStore(ledger) as { bindings: Array<{ principal: string }> }).bindings.map((item) => item.principal), ["é", "Ω"]);
});
