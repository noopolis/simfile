import assert from "node:assert/strict";
import test from "node:test";

import { createWorldReadLedger, readWorldReadLedger, WorldRuntimeError } from "./ledger.js";

const writer = (ledger: ReturnType<typeof createWorldReadLedger>) => readWorldReadLedger(ledger)!;

test("uses private per-principal sequences, filters, and immutable pages", () => {
  const ledger = createWorldReadLedger({ maxEntriesPerPrincipal: 3 });
  writer(ledger).append({ operation: "status", principal: "red", result: "denied" });
  writer(ledger).append({ operation: "affordances", principal: "red", result: "denied" });
  writer(ledger).append({ operation: "capabilities", principal: "blue", result: "denied" });
  writer(ledger).append({ operation: "ledger", principal: "red", result: "allowed", decision_id: "decision-000000000001", state_version: 2,
    identity: { run_id: "run-1", world_id: "pitch", world_instance_id: "one", manifest_digest: `sha256:${"a".repeat(64)}`, state_version: 2 } });
  assert.deepEqual(ledger.read("red", { after: 0, limit: 1 }), {
    records: [{ sequence: 1, operation: "status", principal: "red", result: "denied" }], next_after: 1,
  });
  const page = ledger.read("red", { after: 2, limit: 50, operations: ["ledger"] });
  assert.equal(page.records[0]?.sequence, 3);
  assert.equal(page.records[0]?.principal, "red");
  assert.throws(() => (page.records as unknown as unknown[]).push({}), TypeError);
  assert.throws(() => ((page.records[0]!.identity as unknown) as { state_version: number }).state_version = 9, TypeError);
  assert.deepEqual(ledger.read("red", { operations: ["affordances"] }).records.map((record) => record.operation), ["affordances"]);
});

test("rejects hostile pagination shapes without evaluating accessors or proxies", () => {
  const ledger = createWorldReadLedger();
  let called = 0;
  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, "after", { enumerable: true, get: () => { called += 1; return 0; } });
  const attempts = [
    accessor,
    new Proxy({ after: 0 }, { getPrototypeOf: () => { called += 1; throw new Error("trap"); } }),
    { after: -1 }, { after: 0.5 }, { limit: 101 }, { operations: ["status", "status"] }, { unexpected: true },
  ];
  for (const attempt of attempts) assert.throws(() => ledger.read("red", attempt), (error: unknown) => error instanceof WorldRuntimeError && error.code === "world_runtime_denied");
  assert.equal(called, 0);
});

test("bounds principals, retained strings, and per-principal history without corrupting partitions", () => {
  const ledger = createWorldReadLedger({ maxEntriesPerPrincipal: 2, maxPrincipals: 2 });
  writer(ledger).append({ operation: "status", principal: "red", result: "denied" });
  writer(ledger).append({ operation: "ledger", principal: "red", result: "denied" });
  writer(ledger).append({ operation: "status", principal: "red", result: "denied" });
  writer(ledger).append({ operation: "status", principal: "blue", result: "denied" });
  assert.deepEqual(ledger.read("red", {}).records.map((record) => record.sequence), [2, 3]);
  assert.throws(() => writer(ledger).append({ operation: "status", principal: "green", result: "denied" }), WorldRuntimeError);
  assert.deepEqual(ledger.read("blue", {}).records.map((record) => record.sequence), [1]);
  assert.throws(() => writer(ledger).append({ operation: "status", principal: "x".repeat(257), result: "denied" }), WorldRuntimeError);
  assert.throws(() => writer(ledger).append({ operation: "status", principal: "red", result: "allowed", decision_id: "decision-not-canonical" }), WorldRuntimeError);
});

test("issues a frozen read-only public handle and enforces allowed-record invariants", () => {
  const ledger = createWorldReadLedger();
  assert.equal("append" in ledger, false);
  assert.ok(Object.isFrozen(ledger));
  assert.throws(() => (ledger as unknown as { append: unknown }).append = () => {}, TypeError);
  for (const record of [
    { operation: "status", principal: "red", result: "denied", decision_id: "decision-000000000001" },
    { operation: "status", principal: "red", result: "allowed", decision_id: "decision-000000000001", state_version: 2 },
    { operation: "status", principal: "red", result: "allowed", decision_id: "decision-000000000001", state_version: 2,
      identity: { run_id: "run-1", world_id: "pitch", world_instance_id: "one", manifest_digest: `sha256:${"a".repeat(64)}`, state_version: 3 } },
  ]) assert.throws(() => writer(ledger).append(record as never), WorldRuntimeError);
});

test("reserves known principals atomically and rejects contaminating partitions", () => {
  const undersized = createWorldReadLedger({ maxPrincipals: 1 });
  assert.throws(() => writer(undersized).reservePrincipals(["red", "blue"]), WorldRuntimeError);
  writer(undersized).reservePrincipals(["red"]);
  writer(undersized).append({ operation: "status", principal: "red", result: "denied" });
  assert.equal(undersized.read("red", {}).records.length, 1);

  const contaminated = createWorldReadLedger({ maxPrincipals: 3 });
  writer(contaminated).append({ operation: "status", principal: "unknown", result: "denied" });
  assert.throws(() => writer(contaminated).reservePrincipals(["red", "blue"]), WorldRuntimeError);
  assert.deepEqual(contaminated.read("unknown", {}).records.map((record) => record.sequence), [1]);
});
