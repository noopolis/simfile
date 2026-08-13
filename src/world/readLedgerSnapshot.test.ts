import assert from "node:assert/strict";
import test from "node:test";

import { createWorldReadLedger, readWorldReadLedger, WorldRuntimeError } from "./ledger.js";

const writer = (ledger: ReturnType<typeof createWorldReadLedger>) => readWorldReadLedger(ledger)!;
const allowed = (principal: string) => ({ operation: "ledger" as const, principal, result: "allowed" as const, decision_id: "decision-000000000001", state_version: 2,
  identity: { run_id: "run", world_id: "world", world_instance_id: "instance", manifest_digest: `sha256:${"a".repeat(64)}`, state_version: 2 } });

test("privately snapshots empty, reserved, denied, allowed, and evicted lanes", () => {
  const source = createWorldReadLedger({ maxEntriesPerPrincipal: 2, maxPrincipals: 3 }); const authority = writer(source);
  authority.reservePrincipals(["blue", "red"]); authority.append({ operation: "status", principal: "red", result: "denied" }); authority.append(allowed("red")); authority.append({ operation: "observe", principal: "red", result: "denied" });
  const snapshot = authority.snapshot();
  assert.deepEqual(snapshot.lanes.map((lane) => [lane.principal, lane.last_sequence, lane.evicted_through, lane.records.length]), [["blue", 0, 0, 0], ["red", 3, 1, 2]]);
  assert(Object.isFrozen(snapshot)); assert(Object.isFrozen(snapshot.lanes)); assert(Object.isFrozen(snapshot.lanes[1]!.records));
  const target = createWorldReadLedger({ maxEntriesPerPrincipal: 2, maxPrincipals: 3 }); writer(target).reservePrincipals(["red", "blue"]); writer(target).restore(snapshot);
  assert.deepEqual(writer(target).snapshot(), snapshot); assert.deepEqual(target.read("red", { after: 0 }).records.map((record) => record.sequence), [2, 3]);
  writer(target).append({ operation: "status", principal: "red", result: "denied" }); assert.deepEqual(target.read("red", { after: 0 }).records.map((record) => record.sequence), [3, 4]);
  assert.throws(() => writer(target).restore(snapshot), WorldRuntimeError);
});

test("restored exact lanes reject foreign appends atomically and preserve continuity", () => {
  const source = createWorldReadLedger({ maxEntriesPerPrincipal: 2, maxPrincipals: 2 });
  const sourceWriter = writer(source); sourceWriter.reservePrincipals(["red"]);
  sourceWriter.append({ operation: "status", principal: "red", result: "denied" });
  sourceWriter.append({ operation: "ledger", principal: "red", result: "denied" });
  const snapshot = sourceWriter.snapshot(); const target = createWorldReadLedger({ maxEntriesPerPrincipal: 2, maxPrincipals: 2 });
  const targetWriter = writer(target); targetWriter.restore(snapshot); const before = targetWriter.snapshot();
  assert.throws(() => targetWriter.append({ operation: "status", principal: "blue", result: "denied" }), WorldRuntimeError);
  assert.deepEqual(targetWriter.snapshot(), before);
  assert.deepEqual(target.read("blue", { after: 0 }).records, []);
  assert.deepEqual(target.read("red", { after: 0 }).records.map((record) => record.sequence), [1, 2]);
  targetWriter.append({ operation: "observe", principal: "red", result: "denied" });
  assert.deepEqual(target.read("red", { after: 1, operations: ["observe"] }), {
    records: [{ operation: "observe", principal: "red", result: "denied", sequence: 3 }], next_after: 3,
  });
  assert.deepEqual(target.read("red", { after: 99 }), { records: [], next_after: 99 });
  assert.throws(() => targetWriter.reservePrincipals(["red", "blue"]), WorldRuntimeError);
  const preReserved = createWorldReadLedger({ maxPrincipals: 2 }); const preReservedWriter = writer(preReserved);
  preReservedWriter.reservePrincipals(["red", "blue"]); const preReservedBefore = preReservedWriter.snapshot();
  assert.throws(() => preReservedWriter.restore(snapshot), WorldRuntimeError);
  assert.deepEqual(preReservedWriter.snapshot(), preReservedBefore);
});

test("restores the exact 10,000-record retained suffix and numeric cursor frontier", () => {
  const source = createWorldReadLedger({ maxEntriesPerPrincipal: 10_000, maxPrincipals: 1 }); const sourceWriter = writer(source);
  sourceWriter.reservePrincipals(["red"]);
  for (let sequence = 1; sequence <= 10_000; sequence += 1) sourceWriter.append({ operation: sequence % 2 === 0 ? "ledger" : "status", principal: "red", result: "denied" });
  const snapshot = sourceWriter.snapshot(); assert.equal(snapshot.lanes[0]!.records.length, 10_000);
  const target = createWorldReadLedger({ maxEntriesPerPrincipal: 10_000, maxPrincipals: 1 }); const targetWriter = writer(target);
  targetWriter.restore(snapshot);
  assert.deepEqual(target.read("red", { after: 9_998, limit: 5 }), source.read("red", { after: 9_998, limit: 5 }));
  assert.deepEqual(target.read("red", { after: 10_000 }), { records: [], next_after: 10_000 });
  targetWriter.append({ operation: "observe", principal: "red", result: "denied" });
  const suffix = target.read("red", { after: 0, limit: 100 });
  assert.equal(suffix.records.length, 100); assert.equal(suffix.records[0]!.sequence, 2); assert.equal(suffix.records.at(-1)!.sequence, 101);
  assert.equal(targetWriter.snapshot().lanes[0]!.evicted_through, 1);
});

test("restore is atomic, capacity-bound, and descriptor-safe", () => {
  const source = createWorldReadLedger(); writer(source).reservePrincipals(["red"]); writer(source).append({ operation: "status", principal: "red", result: "denied" }); const snapshot = structuredClone(writer(source).snapshot()) as Record<string, any>;
  const target = createWorldReadLedger(); const targetWriter = writer(target); const before = targetWriter.snapshot();
  snapshot.max_principals = 1; assert.throws(() => targetWriter.restore(snapshot), WorldRuntimeError); assert.deepEqual(targetWriter.snapshot(), before);
  const hostile = structuredClone(writer(source).snapshot()) as Record<string, any>; let touched = false;
  hostile.lanes = new Array(10_001); Object.defineProperty(hostile.lanes, "0", { enumerable: true, get: () => { touched = true; throw new Error("trap"); } });
  assert.throws(() => targetWriter.restore(hostile), WorldRuntimeError); assert.equal(touched, false); assert.deepEqual(targetWriter.snapshot(), before);
  const mismatch = createWorldReadLedger({ maxEntriesPerPrincipal: 2 }); assert.throws(() => writer(mismatch).restore(writer(source).snapshot()), WorldRuntimeError);
});
