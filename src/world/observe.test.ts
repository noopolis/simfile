import assert from "node:assert/strict";
import test from "node:test";

import { WorldRuntimeError } from "./ledger.js";
import type { DynamicsSession } from "../dynamics/session.js";
import { runtimeFixture, runtimeFixtureWithHooks } from "./runtime.test-helper.js";

const denied = (call: () => unknown): void => {
  assert.throws(call, (error: unknown) => error instanceof WorldRuntimeError
    && error.code === "world_runtime_denied");
};

const projectionAction = (actId: string) => ({
  act_id: actId, action: "wait", actor: "object:red", at_tick: 0, input: {}, origin: "test",
  principal_id: "principal-red", target: "object:red",
});

test("observes only the authenticated granted sense in a frozen public envelope", () => {
  const fixture = runtimeFixture();
  const decisions = fixture.decisionRegistry.snapshot();
  const result = fixture.runtime.observe({ principal: "principal-red", decisionToken: fixture.red.token }, {
    sense: "world://pitch/sense/vision",
  });
  assert.deepEqual(result.identity, {
    run_id: "run-1", world_id: "pitch", world_instance_id: "instance-1",
    manifest_digest: result.identity.manifest_digest, state_version: 0,
  });
  assert.equal(result.sense, "world://pitch/sense/vision");
  assert.equal(result.observer, "world://pitch/entity/red");
  assert.deepEqual(result.observation, {
    channels: [{ components: { x: 1 }, sense_address: "world://pitch/sense/vision", subject_address: "world://pitch/entity/red", unit: "meters" }],
  });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.observation.channels[0]!.components));
  assert.throws(() => (result.observation.channels as unknown as unknown[]).push({}), TypeError);
  assert.equal(JSON.stringify(result).includes("sense:state"), false);
  assert.equal(fixture.dynamicsCalls(), 1);
  assert.deepEqual(fixture.decisionRegistry.snapshot(), decisions);
});

test("passes only frozen scoped mechanics to a projection that derives public channels", () => {
  let providerInput: unknown;
  let projectionInput: unknown;
  const fixture = runtimeFixtureWithHooks({
    observe: (input) => {
      providerInput = input;
      return { channels: [{ components: { x: 7 }, sense_address: "sense:state", subject_address: "object:red", unit: "meters" }] };
    },
    project: (input) => {
      projectionInput = input;
      return { channels: input.observation.channels.map((channel) => ({
        components: channel.components, sense_address: "sense:vision", subject_address: "entity:red", unit: channel.unit,
      })) };
    },
  });
  const result = fixture.runtime!.observe({ principal: "principal-red", decisionToken: fixture.red.token }, { sense: "world://pitch/sense/vision" });
  assert.deepEqual(providerInput, { sense_addresses: ["sense:state"], sim_time: 0, tick: 0 });
  assert.deepEqual(Reflect.ownKeys(providerInput as object), ["sense_addresses", "sim_time", "tick"]);
  assert.ok(Object.isFrozen(providerInput));
  assert.ok(Object.isFrozen((providerInput as { sense_addresses: unknown }).sense_addresses));
  assert.deepEqual(JSON.parse(JSON.stringify(projectionInput)), { holder: "entity:red", observation: { channels: [{ components: { x: 7 }, sense_address: "sense:state", subject_address: "object:red", unit: "meters" }] } });
  assert.ok(Object.isFrozen(projectionInput));
  assert.deepEqual(result.observation.channels[0]!.components, { x: 7 });
  assert.equal(JSON.stringify(result).includes("sense:state"), false);
});

test("denies hostile providers and leaves their complete session checkpoint unchanged", () => {
  const hostile = [
    () => { throw new Error("provider"); },
    () => Promise.resolve({ channels: [] }),
    (_input: unknown, state: Record<string, unknown>) => { state.changed = true; return { channels: [] }; },
    () => ({}),
    () => ({ channels: [{ components: { x: 1 }, sense_address: "sense:secret", subject_address: "object:red" }] }),
  ];
  for (const observe of hostile) {
    const fixture = runtimeFixtureWithHooks({ observe });
    const before = fixture.dynamics.snapshot();
    denied(() => fixture.runtime!.observe({ principal: "principal-red", decisionToken: fixture.red.token }, { sense: "world://pitch/sense/vision" }));
    assert.deepEqual(fixture.dynamics.snapshot(), before);
    assert.deepEqual(fixture.readLedger.read("principal-red", {}).records.map((record) => [record.operation, record.result]), [["observe", "denied"]]);
  }
});

test("denies and exactly restores complete state after every hostile projection result", () => {
  const projectors = [
    (dynamics: DynamicsSession, state: Record<string, unknown>) => { state.changed = "throw"; dynamics.queueAction(projectionAction("projection-throw")); throw new Error("projection"); },
    (dynamics: DynamicsSession, state: Record<string, unknown>) => { state.changed = "promise"; dynamics.queueAction(projectionAction("projection-promise")); return Promise.resolve({ channels: [] }); },
    (dynamics: DynamicsSession, state: Record<string, unknown>) => { state.changed = "malformed"; dynamics.queueAction(projectionAction("projection-malformed")); return {}; },
    (dynamics: DynamicsSession, state: Record<string, unknown>) => { state.changed = "valid"; dynamics.queueAction(projectionAction("projection-valid")); return { channels: [{ components: { x: 1 }, sense_address: "sense:vision", subject_address: "entity:red", unit: "meters" }] }; },
  ];
  for (const mutateAndResult of projectors) {
    let capturedState: Record<string, unknown> | undefined;
    const fixture = runtimeFixtureWithHooks({
      observe: (_input, state) => {
        capturedState = state;
        return { channels: [{ components: { x: 1 }, sense_address: "sense:state", subject_address: "object:red" }] };
      },
      project: (_input, dynamics) => mutateAndResult(dynamics, capturedState!),
    });
    const before = fixture.dynamics.snapshot();
    denied(() => fixture.runtime!.observe({ principal: "principal-red", decisionToken: fixture.red.token }, { sense: "world://pitch/sense/vision" }));
    assert.deepEqual(fixture.dynamics.snapshot(), before);
    assert.deepEqual(fixture.readLedger.read("principal-red", {}).records.map((record) => [record.operation, record.result]), [["observe", "denied"]]);
  }
});

test("keeps caught and uncaught projection reentry to one nested denial and one outer record", () => {
  let caught = runtimeFixtureWithHooks({
    project: (input) => {
      try { caught.runtime!.observe({ principal: "principal-red", decisionToken: caught.red.token }, { sense: "world://pitch/sense/vision" }); } catch { /* Expected nested denial. */ }
      return { channels: input.observation.channels.map((channel) => ({ components: channel.components, sense_address: "sense:vision", subject_address: "entity:red" })) };
    },
  });
  caught.runtime!.observe({ principal: "principal-red", decisionToken: caught.red.token }, { sense: "world://pitch/sense/vision" });
  assert.deepEqual(caught.readLedger.read("principal-red", {}).records.map((record) => [record.operation, record.result]), [["observe", "denied"], ["observe", "allowed"]]);
  assert.equal(caught.dynamicsCalls(), 1);

  let uncaught = runtimeFixtureWithHooks({
    project: () => uncaught.runtime!.observe({ principal: "principal-red", decisionToken: uncaught.red.token }, { sense: "world://pitch/sense/vision" }),
  });
  denied(() => uncaught.runtime!.observe({ principal: "principal-red", decisionToken: uncaught.red.token }, { sense: "world://pitch/sense/vision" }));
  assert.deepEqual(uncaught.readLedger.read("principal-red", {}).records.map((record) => [record.operation, record.result]), [["observe", "denied"], ["observe", "denied"]]);
  assert.equal(uncaught.dynamicsCalls(), 1);
});

test("keeps caught and uncaught provider reentry before a second provider call", () => {
  let caughtCalls = 0;
  let caught: ReturnType<typeof runtimeFixtureWithHooks>;
  caught = runtimeFixtureWithHooks({
    observe: (input) => {
      caughtCalls += 1;
      try { caught.runtime!.observe({ principal: "principal-red", decisionToken: caught.red.token }, { sense: "world://pitch/sense/vision" }); } catch { /* Expected nested denial. */ }
      return { channels: [{ components: { x: 3 }, sense_address: "sense:state", subject_address: "object:red" }] };
    },
  });
  caught.runtime!.observe({ principal: "principal-red", decisionToken: caught.red.token }, { sense: "world://pitch/sense/vision" });
  assert.equal(caughtCalls, 1);
  assert.deepEqual(caught.readLedger.read("principal-red", {}).records.map((record) => [record.operation, record.result]), [["observe", "denied"], ["observe", "allowed"]]);

  let uncaughtCalls = 0;
  let uncaught: ReturnType<typeof runtimeFixtureWithHooks>;
  uncaught = runtimeFixtureWithHooks({
    observe: () => {
      uncaughtCalls += 1;
      return uncaught.runtime!.observe({ principal: "principal-red", decisionToken: uncaught.red.token }, { sense: "world://pitch/sense/vision" });
    },
  });
  denied(() => uncaught.runtime!.observe({ principal: "principal-red", decisionToken: uncaught.red.token }, { sense: "world://pitch/sense/vision" }));
  assert.equal(uncaughtCalls, 1);
  assert.deepEqual(uncaught.readLedger.read("principal-red", {}).records.map((record) => [record.operation, record.result]), [["observe", "denied"], ["observe", "denied"]]);
});

test("keeps repeated valid observes pure and isolated", () => {
  const fixture = runtimeFixture();
  const beforeDynamics = fixture.dynamics.snapshot();
  const beforeDecisions = fixture.decisionRegistry.snapshot();
  const first = fixture.runtime.observe({ principal: "principal-red", decisionToken: fixture.red.token }, { sense: "world://pitch/sense/vision" });
  const second = fixture.runtime.observe({ principal: "principal-red", decisionToken: fixture.red.token }, { sense: "world://pitch/sense/vision" });
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  assert.equal(fixture.dynamicsCalls(), 2);
  assert.deepEqual(fixture.dynamics.snapshot(), beforeDynamics);
  assert.deepEqual(fixture.decisionRegistry.snapshot(), beforeDecisions);
  assert.deepEqual(fixture.readLedger.read("principal-red", {}).records.map((record) => [record.operation, record.result]), [["observe", "allowed"], ["observe", "allowed"]]);
});

test("denies observe for every terminal decision admission before callbacks", () => {
  const cases = [
    { name: "wrong principal/token", prepare: (_fixture: ReturnType<typeof runtimeFixtureWithHooks>) => ({ principal: "principal-red", token: _fixture.blue.token }) },
    { name: "expired", prepare: (fixture: ReturnType<typeof runtimeFixtureWithHooks>) => { fixture.dynamics.step(); fixture.dynamics.step(); fixture.dynamics.step(); return { principal: "principal-red", token: fixture.red.token }; } },
    { name: "consumed", prepare: (fixture: ReturnType<typeof runtimeFixtureWithHooks>) => { fixture.decisionRegistry.consumeForAct({ principal: "principal-red", runId: "run-1", worldInstanceId: "instance-1", token: fixture.red.token, atTick: 0 }); return { principal: "principal-red", token: fixture.red.token }; } },
    { name: "admissions closed", prepare: (fixture: ReturnType<typeof runtimeFixtureWithHooks>) => { fixture.decisionRegistry.consumeForAct({ principal: "principal-red", runId: "run-1", worldInstanceId: "instance-1", token: fixture.red.token, atTick: 0 }); fixture.decisionRegistry.consumeForAct({ principal: "principal-blue", runId: "run-1", worldInstanceId: "instance-1", token: fixture.blue.token, atTick: 0 }); fixture.decisionRegistry.beginCutoff(0); fixture.decisionRegistry.closeAdmissions(0); assert.equal(fixture.decisionRegistry.inspect().phase, "admissions_closed"); return { principal: "principal-red", token: fixture.red.token }; } },
    { name: "finalized", prepare: (fixture: ReturnType<typeof runtimeFixtureWithHooks>) => { fixture.decisionRegistry.consumeForAct({ principal: "principal-red", runId: "run-1", worldInstanceId: "instance-1", token: fixture.red.token, atTick: 0 }); fixture.decisionRegistry.consumeForAct({ principal: "principal-blue", runId: "run-1", worldInstanceId: "instance-1", token: fixture.blue.token, atTick: 0 }); fixture.decisionRegistry.beginCutoff(0); fixture.decisionRegistry.closeAdmissions(0); fixture.decisionRegistry.finalize(0); assert.equal(fixture.decisionRegistry.inspect().phase, "finalized"); return { principal: "principal-red", token: fixture.red.token }; } },
  ] as const;
  for (const admissionCase of cases) {
    let providerCalls = 0;
    let projectionCalls = 0;
    const fixture = runtimeFixtureWithHooks({
      observe: () => { providerCalls += 1; return { channels: [{ components: { x: 1 }, sense_address: "sense:state", subject_address: "object:red" }] }; },
      project: (input, dynamics) => { projectionCalls += 1; return { channels: input.observation.channels }; },
    });
    const context = admissionCase.prepare(fixture);
    const beforeDynamics = fixture.dynamics.snapshot();
    const beforeDecisions = fixture.decisionRegistry.snapshot();
    denied(() => fixture.runtime!.observe({ principal: context.principal, decisionToken: context.token }, { sense: "world://pitch/sense/vision" }));
    assert.equal(providerCalls, 0, admissionCase.name);
    assert.equal(projectionCalls, 0, admissionCase.name);
    assert.deepEqual(fixture.dynamics.snapshot(), beforeDynamics, admissionCase.name);
    assert.deepEqual(fixture.decisionRegistry.snapshot(), beforeDecisions, admissionCase.name);
    assert.deepEqual(fixture.readLedger.read("principal-red", {}).records.map((record) => [record.operation, record.result]), [["observe", "denied"]], admissionCase.name);
  }
});

test("denies malformed, foreign, local, mechanics, and ungranted senses without disclosure", () => {
  const fixture = runtimeFixture();
  let accessed = 0;
  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, "sense", { enumerable: true, get: () => { accessed += 1; return "world://pitch/sense/vision"; } });
  const requests: unknown[] = [
    undefined, null, {}, { sense: "sense:vision" }, { sense: "sense:state" },
    { sense: "world://other/sense/vision" }, { sense: "world://pitch/sense/missing" },
    { sense: "world://pitch/sense/blue-view" }, accessor, new Proxy({ sense: "world://pitch/sense/vision" }, {}),
  ];
  for (const request of requests) denied(() => fixture.runtime.observe({ principal: "principal-red", decisionToken: fixture.red.token }, request));
  denied(() => fixture.runtime.observe({ principal: "principal-blue", decisionToken: fixture.blue.token }, { sense: "world://pitch/sense/vision" }));
  assert.equal(accessed, 0);
  assert.equal(fixture.dynamicsCalls(), 0);
  assert.deepEqual(fixture.readLedger.read("principal-red", {}).records.map((record) => [record.operation, record.result]),
    requests.map(() => ["observe", "denied"]));
});

test("records allowed observations and accepts observe ledger filters", () => {
  const fixture = runtimeFixture();
  fixture.runtime.observe({ principal: "principal-red", decisionToken: fixture.red.token }, { sense: "world://pitch/sense/vision" });
  const page = fixture.runtime.ledger({ principal: "principal-red", decisionToken: fixture.red.token }, { operations: ["observe"] });
  assert.equal(page.records.length, 1);
  assert.equal(page.records[0]!.operation, "observe");
  assert.equal(page.records[0]!.result, "allowed");
  assert.equal(page.records[0]!.identity!.state_version, 0);
});
