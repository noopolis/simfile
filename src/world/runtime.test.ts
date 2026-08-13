import assert from "node:assert/strict";
import test from "node:test";

import { createWorldReadLedger, readWorldReadLedger, WorldRuntimeError } from "./ledger.js";
import { createWorldRuntime } from "./runtime.js";
import { runtimeFixture } from "./runtime.test-helper.js";
import * as world from "./index.js";

test("scopes red and blue status and capability documents without mechanics reads", () => {
  const fixture = runtimeFixture();
  const beforeDecisions = fixture.decisionRegistry.snapshot();
  const red = fixture.runtime.status({ principal: "principal-red", decisionToken: fixture.red.token });
  const blue = fixture.runtime.capabilities({ principal: "principal-blue", decisionToken: fixture.blue.token });
  assert.deepEqual(red.identity, { run_id: "run-1", world_id: "pitch", world_instance_id: "instance-1", manifest_digest: red.identity.manifest_digest, state_version: 0 });
  assert.equal(red.orientation.holder_entity, "world://pitch/entity/red");
  assert.equal(blue.manifest.holder.entity, "world://pitch/entity/blue");
  assert.notEqual(red.identity.manifest_digest, blue.identity.manifest_digest);
  assert.equal(fixture.dynamicsCalls(), 0);
  assert.deepEqual(fixture.decisionRegistry.snapshot(), beforeDecisions);
  assert.throws(() => (blue.manifest.senses as unknown as unknown[]).push({}), TypeError);
});

test("fails closed for wrong and expired admissions and audits a trusted principal", () => {
  const fixture = runtimeFixture();
  assert.throws(() => fixture.runtime.status({ principal: "principal-red", decisionToken: fixture.blue.token }),
    (error: unknown) => error instanceof WorldRuntimeError && error.code === "world_runtime_denied" && !String(error).includes(fixture.blue.token));
  const page = fixture.runtime.ledger({ principal: "principal-red", decisionToken: fixture.red.token }, {});
  assert.equal(page.records.length, 1);
  assert.deepEqual(page.records[0], { sequence: 1, operation: "status", principal: "principal-red", result: "denied" });
  assert.equal(page.next_after, 1);
});

test("rejects reordered, duplicate, and copied composition before exposing a runtime", () => {
  const fixture = runtimeFixture();
  const source = { dynamics: {}, surfaceRegistry: fixture.surfaceRegistry, capabilityManifests: fixture.capabilityManifests, boundGrants: fixture.boundGrants, decisionRegistry: fixture.decisionRegistry, readLedger: fixture.readLedger };
  for (const input of [
    { ...source, capabilityManifests: [...fixture.capabilityManifests].reverse() },
    { ...source, capabilityManifests: [...fixture.capabilityManifests, fixture.capabilityManifests[0]!] },
    { ...source, surfaceRegistry: { ...fixture.surfaceRegistry } },
  ]) assert.throws(() => createWorldRuntime(input), (error: unknown) => error instanceof WorldRuntimeError && error.code === "world_runtime_invalid_composition");
});

test("a ledger read snapshots before appending itself", () => {
  const fixture = runtimeFixture();
  fixture.runtime.status({ principal: "principal-red", decisionToken: fixture.red.token });
  const first = fixture.runtime.ledger({ principal: "principal-red", decisionToken: fixture.red.token }, {});
  assert.deepEqual(first.records.map((record) => record.operation), ["status"]);
  const second = fixture.runtime.ledger({ principal: "principal-red", decisionToken: fixture.red.token }, { after: first.next_after });
  assert.deepEqual(second.records.map((record) => record.operation), ["ledger"]);
});

test("accepts only issued frozen authorities and exact B18 grant order", () => {
  const fixture = runtimeFixture(false);
  const base = { dynamics: fixture.dynamics, surfaceRegistry: fixture.surfaceRegistry, capabilityManifests: fixture.capabilityManifests, boundGrants: fixture.boundGrants, decisionRegistry: fixture.decisionRegistry, readLedger: fixture.readLedger };
  for (const input of [
    { ...base, dynamics: {} }, { ...base, decisionRegistry: {} }, { ...base, readLedger: {} },
    { ...base, dynamics: { ...fixture.dynamics } }, { ...base, decisionRegistry: new Proxy(fixture.decisionRegistry, {}) }, { ...base, readLedger: new Proxy(fixture.readLedger, {}) },
  ]) assert.throws(() => createWorldRuntime(input as never), (error: unknown) => error instanceof WorldRuntimeError && error.code === "world_runtime_invalid_composition");
  assert.throws(() => { (fixture.dynamics as unknown as { nextTick: number }).nextTick = 9; }, TypeError);
  assert.throws(() => { (fixture.decisionRegistry as unknown as { mint: unknown }).mint = undefined; }, TypeError);
  assert.equal("append" in fixture.readLedger, false);
  const runtime = createWorldRuntime(base);
  assert.equal(runtime.status({ principal: "principal-red", decisionToken: fixture.red.token }).orientation.holder_entity, "world://pitch/entity/red");
  assert.equal((world as Record<string, unknown>).createWorldReadLedgerForTesting, undefined);
  assert.equal((world as Record<string, unknown>).readDecisionRegistry, undefined);
  assert.equal((world as Record<string, unknown>).readWorldReadLedger, undefined);
  assert.equal((world as Record<string, unknown>).readBoundWorldGrants, undefined);
  assert.equal((world as Record<string, unknown>).readParsedWorldSurfaceRegistry, undefined);
  assert.equal((world as Record<string, unknown>).affordancesWorldRuntime, undefined);
  assert.equal((world as Record<string, unknown>).observeScopedWorldRuntime, undefined);
});

test("rejects every copied or reordered B18 grant set before recompiling B19 manifests", () => {
  const fixture = runtimeFixture(false);
  const base = { dynamics: fixture.dynamics, surfaceRegistry: fixture.surfaceRegistry, capabilityManifests: fixture.capabilityManifests, decisionRegistry: fixture.decisionRegistry, readLedger: fixture.readLedger };
  const copied = fixture.boundGrants.map((grant) => ({ ...grant, senses: [...grant.senses], affordances: [...grant.affordances] }));
  const duplicate = [...fixture.boundGrants, fixture.boundGrants[1]!];
  const omission = fixture.boundGrants.slice(1);
  const addition = [...fixture.boundGrants, fixture.boundGrants[0]!];
  const sensesReversed = copied.map((grant) => grant.participant === "red" ? { ...grant, senses: [...grant.senses].reverse() } : grant);
  const affordancesReversed = copied.map((grant) => grant.participant === "red" ? { ...grant, affordances: [...grant.affordances].reverse() } : grant);
  assert.equal(copied.find((grant) => grant.participant === "red")!.senses.length, 2);
  assert.equal(copied.find((grant) => grant.participant === "red")!.affordances.length, 2);
  assert.notDeepEqual(sensesReversed, copied);
  assert.notDeepEqual(affordancesReversed, copied);
  for (const grants of [copied, [...fixture.boundGrants].reverse(), sensesReversed, affordancesReversed, duplicate, omission, addition, new Proxy(fixture.boundGrants, {})]) {
    assert.throws(() => createWorldRuntime({ ...base, boundGrants: grants } as never), (error: unknown) => error instanceof WorldRuntimeError && error.code === "world_runtime_invalid_composition");
  }
});

test("rejects current bindings that cannot be retained in a ledger record", () => {
  for (const identity of [
    { runId: "r".repeat(257), worldInstanceId: "instance-1" },
    { runId: "run-1", worldInstanceId: "i".repeat(257) },
    { runId: "run-1", worldInstanceId: "instance-1", redPrincipal: "p".repeat(257) },
  ]) {
    const fixture = runtimeFixture(false, identity);
    assert.throws(() => createWorldRuntime({ dynamics: fixture.dynamics, surfaceRegistry: fixture.surfaceRegistry, capabilityManifests: fixture.capabilityManifests, boundGrants: fixture.boundGrants, decisionRegistry: fixture.decisionRegistry, readLedger: fixture.readLedger }), WorldRuntimeError);
  }
});

test("audits exactly once per attributed result without touching mechanics state", () => {
  const fixture = runtimeFixture();
  fixture.runtime.status({ principal: "principal-red", decisionToken: fixture.red.token });
  assert.throws(() => fixture.runtime.capabilities({ principal: "principal-red", decisionToken: fixture.blue.token }), WorldRuntimeError);
  const records = fixture.readLedger.read("principal-red", {}).records;
  assert.deepEqual(records.map((record) => [record.operation, record.result]), [["status", "allowed"], ["capabilities", "denied"]]);
  assert.equal(fixture.dynamicsCalls(), 0);
});

test("claims each live authority once and rejects cross-runtime reuse before calls", () => {
  const first = runtimeFixture();
  for (const field of ["dynamics", "decisionRegistry", "readLedger"] as const) {
    const second = runtimeFixture(false);
    assert.throws(() => createWorldRuntime({
      dynamics: field === "dynamics" ? first.dynamics : second.dynamics,
      surfaceRegistry: second.surfaceRegistry, capabilityManifests: second.capabilityManifests, boundGrants: second.boundGrants,
      decisionRegistry: field === "decisionRegistry" ? first.decisionRegistry : second.decisionRegistry,
      readLedger: field === "readLedger" ? first.readLedger : second.readLedger,
    }), (error: unknown) => error instanceof WorldRuntimeError && error.code === "world_runtime_invalid_composition");
  }
  const crossRun = runtimeFixture(false, { runId: "run-2", worldInstanceId: "instance-2" });
  assert.throws(() => createWorldRuntime({
    dynamics: first.dynamics, surfaceRegistry: crossRun.surfaceRegistry, capabilityManifests: crossRun.capabilityManifests,
    boundGrants: crossRun.boundGrants, decisionRegistry: crossRun.decisionRegistry, readLedger: first.readLedger,
  }), (error: unknown) => error instanceof WorldRuntimeError && error.code === "world_runtime_invalid_composition");
  assert.equal(first.dynamicsCalls(), 0);
});

test("rejects preloaded records outside the current runtime identity without returning them", () => {
  const fixture = runtimeFixture(false);
  const writer = readWorldReadLedger(fixture.readLedger)!;
  writer.append({ operation: "status", principal: "principal-red", result: "allowed", decision_id: "decision-000000000001", state_version: 0,
    identity: { run_id: fixture.red.token, world_id: "pitch", world_instance_id: "instance-1", manifest_digest: `sha256:${"a".repeat(64)}`, state_version: 0 } });
  const runtime = createWorldRuntime({ dynamics: fixture.dynamics, surfaceRegistry: fixture.surfaceRegistry, capabilityManifests: fixture.capabilityManifests, boundGrants: fixture.boundGrants, decisionRegistry: fixture.decisionRegistry, readLedger: fixture.readLedger });
  assert.throws(() => runtime.ledger!({ principal: "principal-red", decisionToken: fixture.red.token }, {}), WorldRuntimeError);
  assert.equal(fixture.dynamicsCalls(), 0);
});

test("reserves every manifest principal before unknown callers can consume capacity", () => {
  const undersized = runtimeFixture(false, {
    runId: "run-1",
    worldInstanceId: "instance-1",
    maxLedgerPrincipals: 1,
  });
  assert.throws(() => createWorldRuntime({
    dynamics: undersized.dynamics,
    surfaceRegistry: undersized.surfaceRegistry,
    capabilityManifests: undersized.capabilityManifests,
    boundGrants: undersized.boundGrants,
    decisionRegistry: undersized.decisionRegistry,
    readLedger: undersized.readLedger,
  }), (error: unknown) => error instanceof WorldRuntimeError && error.code === "world_runtime_invalid_composition");
  const recovered = createWorldRuntime({
    dynamics: undersized.dynamics,
    surfaceRegistry: undersized.surfaceRegistry,
    capabilityManifests: undersized.capabilityManifests,
    boundGrants: undersized.boundGrants,
    decisionRegistry: undersized.decisionRegistry,
    readLedger: createWorldReadLedger({ maxEntriesPerPrincipal: 20, maxPrincipals: 2 }),
  });
  assert.equal(recovered.status({
    principal: "principal-red",
    decisionToken: undersized.red.token,
  }).orientation.holder_entity, "world://pitch/entity/red");

  const fixture = runtimeFixture(false, {
    runId: "run-1",
    worldInstanceId: "instance-1",
    maxLedgerPrincipals: 2,
  });
  const runtime = createWorldRuntime({
    dynamics: fixture.dynamics,
    surfaceRegistry: fixture.surfaceRegistry,
    capabilityManifests: fixture.capabilityManifests,
    boundGrants: fixture.boundGrants,
    decisionRegistry: fixture.decisionRegistry,
    readLedger: fixture.readLedger,
  });
  assert.throws(() => runtime.status({ principal: "unknown", decisionToken: "not-a-token" }), WorldRuntimeError);
  assert.equal(runtime.status({ principal: "principal-red", decisionToken: fixture.red.token }).orientation.holder_entity, "world://pitch/entity/red");
  assert.equal(runtime.status({ principal: "principal-blue", decisionToken: fixture.blue.token }).orientation.holder_entity, "world://pitch/entity/blue");
  assert.equal(fixture.readLedger.read("unknown", {}).records.length, 0);
  assert.equal(fixture.readLedger.read("principal-red", {}).records.length, 1);
  assert.equal(fixture.readLedger.read("principal-blue", {}).records.length, 1);
});
