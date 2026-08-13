import assert from "node:assert/strict";
import test from "node:test";

import type { DynamicsSession } from "../dynamics/session.js";
import { WorldRuntimeError } from "./ledger.js";
import { runtimeFixtureWithHooks } from "./runtime.test-helper.js";

const denied = (call: () => unknown): void => assert.throws(call, (error: unknown) =>
  error instanceof WorldRuntimeError && error.code === "world_runtime_denied");
const action = (id: string) => ({ act_id: id, action: "wait", actor: "object:red", at_tick: 0,
  input: {}, origin: "controller", principal_id: "principal-red", target: "object:red" });
const valid = (input: unknown) => ({ channels: [{ components: { x: 1 }, sense_address: (input as { sense_addresses: readonly string[] }).sense_addresses[0]!, subject_address: "object:red" }] });
const context = (fixture: ReturnType<typeof runtimeFixtureWithHooks>) =>
  ({ principal: "principal-red", decisionToken: fixture.red.token });
const audit = (fixture: ReturnType<typeof runtimeFixtureWithHooks>, result: "allowed" | "denied") =>
  assert.deepEqual(fixture.readLedger.read("principal-red", {}).records.map((record) => [record.operation, record.result]), [["affordances", result]]);

test("provider rollback is owned once and a denied runtime remains reusable", () => {
  const cases: readonly [string, (input: unknown, state: Record<string, unknown>, dynamics: DynamicsSession) => unknown, number][] = [
    ["throw", () => { throw new Error("provider"); }, 1],
    ["promise", () => Promise.resolve(valid({ sense_addresses: ["sense:state"] })), 1],
    ["malformed", () => ({ nope: true }), 1],
    ["provider mutation", (_input, state) => { state.value = 1; return valid({ sense_addresses: ["sense:state"] }); }, 1],
    ["queued host mutation", (_input, _state, dynamics) => { dynamics.queueAction(action("provider-queue")); return valid({ sense_addresses: ["sense:state"] }); }, 1],
    ["stepped host mutation", (_input, _state, dynamics) => { dynamics.step(); return valid({ sense_addresses: ["sense:state"] }); }, 1],
    ["provider mutation + throw", (_input, state) => { state.value = 1; throw new Error("provider"); }, 1],
    ["provider mutation + promise", (_input, state) => { state.value = 1; return Promise.resolve(valid({ sense_addresses: ["sense:state"] })); }, 1],
    ["provider mutation + malformed", (_input, state) => { state.value = 1; return { nope: true }; }, 1],
    ["queued host mutation + throw", (_input, _state, dynamics) => { dynamics.queueAction(action("provider-queue-throw")); throw new Error("provider"); }, 2],
    ["queued host mutation + promise", (_input, _state, dynamics) => { dynamics.queueAction(action("provider-queue-promise")); return Promise.resolve(valid({ sense_addresses: ["sense:state"] })); }, 2],
    ["queued host mutation + malformed", (_input, _state, dynamics) => { dynamics.queueAction(action("provider-queue-malformed")); return { nope: true }; }, 2],
    ["stepped host mutation + throw", (_input, _state, dynamics) => { dynamics.step(); throw new Error("provider"); }, 2],
    ["stepped host mutation + promise", (_input, _state, dynamics) => { dynamics.step(); return Promise.resolve(valid({ sense_addresses: ["sense:state"] })); }, 2],
    ["stepped host mutation + malformed", (_input, _state, dynamics) => { dynamics.step(); return { nope: true }; }, 2],
  ];
  for (const [_name, hostile, restores] of cases) {
    let enabled = true;
    let providers = 0; let projections = 0; let availability = 0;
    const fixture = runtimeFixtureWithHooks({
      observe: (input, state, dynamics) => { providers += 1; return enabled ? hostile(input, state, dynamics) : valid(input); },
      project: (input) => { projections += 1; return { channels: input.observation.channels.map((channel) => ({ ...channel, sense_address: "sense:vision", subject_address: "entity:red" })) }; },
      available: () => { availability += 1; return true; },
    }, true, { runId: "run-1", worldInstanceId: "instance-1", redSenses: ["world://pitch/sense/vision"], redAffordances: ["world://pitch/affordance/wait"] });
    const before = fixture.dynamics.snapshot(); denied(() => fixture.runtime!.affordances(context(fixture)));
    assert.deepEqual(fixture.dynamics.snapshot(), before); assert.equal(fixture.restoreCalls(), restores, _name); audit(fixture, "denied");
    enabled = false; fixture.runtime!.affordances(context(fixture));
    assert.deepEqual([providers, projections, availability], [2, 1, 1]);
  }
});

test("projection rollback restores only mutation and remains reusable", () => {
  const cases: readonly [string, (dynamics: DynamicsSession) => unknown, number][] = [
    ["throw", () => { throw new Error("projection"); }, 0], ["promise", () => Promise.resolve({ channels: [] }), 0], ["malformed", () => ({ nope: true }), 0],
    ["mutation valid", (dynamics) => { dynamics.step(); return { channels: [] }; }, 1],
    ["mutation throw", (dynamics) => { dynamics.step(); throw new Error("projection"); }, 1],
    ["mutation promise", (dynamics) => { dynamics.step(); return Promise.resolve({ channels: [] }); }, 1],
    ["mutation malformed", (dynamics) => { dynamics.step(); return {}; }, 1],
  ];
  for (const [_name, hostile, restores] of cases) {
    let enabled = true; let providers = 0; let projections = 0; let availability = 0;
    const fixture = runtimeFixtureWithHooks({ observe: (input) => { providers += 1; return valid(input); }, project: (input, dynamics) => {
      projections += 1; return enabled ? hostile(dynamics) : { channels: input.observation.channels.map((channel) => ({ ...channel, sense_address: "sense:vision", subject_address: "entity:red" })) };
    }, available: () => { availability += 1; return true; } }, true, { runId: "run-1", worldInstanceId: "instance-1", redSenses: ["world://pitch/sense/vision"], redAffordances: ["world://pitch/affordance/wait"] });
    const before = fixture.dynamics.snapshot(); denied(() => fixture.runtime!.affordances(context(fixture)));
    assert.deepEqual(fixture.dynamics.snapshot(), before); assert.equal(fixture.restoreCalls(), restores, _name); audit(fixture, "denied");
    enabled = false; fixture.runtime!.affordances(context(fixture)); assert.deepEqual([providers, projections, availability], [2, 2, 1]);
  }
});

test("availability pure failures avoid restore while mutations restore once", () => {
  const cases: readonly [string, (dynamics: DynamicsSession) => unknown, number][] = [
    ["throw", () => { throw new Error("available"); }, 0], ["promise", () => Promise.resolve(true), 0], ["malformed", () => "true", 0],
    ...([true, false, "throw", "promise", "malformed"] as const).map((outcome): [string, (dynamics: DynamicsSession) => unknown, number] => [
      `mutation ${outcome}`, (dynamics) => { dynamics.step(); if (outcome === "throw") throw new Error("available"); if (outcome === "promise") return Promise.resolve(true); if (outcome === "malformed") return {}; return outcome; }, 1,
    ]),
    ...([true, false, "throw", "promise", "malformed"] as const).map((outcome): [string, (dynamics: DynamicsSession) => unknown, number] => [
      `queue mutation ${outcome}`, (dynamics) => { dynamics.queueAction(action(`available-queue-${outcome}`)); if (outcome === "throw") throw new Error("available"); if (outcome === "promise") return Promise.resolve(true); if (outcome === "malformed") return {}; return outcome; }, 1,
    ]),
    ["step mutation", (dynamics) => { dynamics.step(); return true; }, 1],
  ];
  for (const [_name, hostile, restores] of cases) {
    let enabled = true; let providers = 0; let projections = 0; let availability = 0;
    const fixture = runtimeFixtureWithHooks({ observe: (input) => { providers += 1; return valid(input); }, project: (input) => { projections += 1; return { channels: input.observation.channels.map((channel) => ({ ...channel, sense_address: "sense:vision", subject_address: "entity:red" })) }; }, available: (_input, dynamics) => { availability += 1; return enabled ? hostile(dynamics) : true; } }, true, { runId: "run-1", worldInstanceId: "instance-1", redSenses: ["world://pitch/sense/vision"], redAffordances: ["world://pitch/affordance/wait"] });
    const before = fixture.dynamics.snapshot(); denied(() => fixture.runtime!.affordances(context(fixture)));
    assert.deepEqual(fixture.dynamics.snapshot(), before); assert.equal(fixture.restoreCalls(), restores, _name); audit(fixture, "denied");
    enabled = false; fixture.runtime!.affordances(context(fixture)); assert.deepEqual([providers, projections, availability], [2, 2, 2]);
  }
});

test("terminal and identity denials invoke no callbacks and audit the supplied principal", () => {
  const cases = [
    (fixture: ReturnType<typeof runtimeFixtureWithHooks>) => ({ principal: "principal-red", decisionToken: fixture.blue.token }),
    (fixture: ReturnType<typeof runtimeFixtureWithHooks>) => ({ principal: "unknown", decisionToken: fixture.red.token }),
    (fixture: ReturnType<typeof runtimeFixtureWithHooks>) => { fixture.dynamics.step(); fixture.dynamics.step(); fixture.dynamics.step(); return context(fixture); },
    (fixture: ReturnType<typeof runtimeFixtureWithHooks>) => { fixture.decisionRegistry.consumeForAct({ principal: "principal-red", runId: "run-1", worldInstanceId: "instance-1", token: fixture.red.token, atTick: 0 }); return context(fixture); },
    (fixture: ReturnType<typeof runtimeFixtureWithHooks>) => { fixture.decisionRegistry.consumeForAct({ principal: "principal-red", runId: "run-1", worldInstanceId: "instance-1", token: fixture.red.token, atTick: 0 }); fixture.decisionRegistry.consumeForAct({ principal: "principal-blue", runId: "run-1", worldInstanceId: "instance-1", token: fixture.blue.token, atTick: 0 }); fixture.decisionRegistry.beginCutoff(0); fixture.decisionRegistry.closeAdmissions(0); assert.equal(fixture.decisionRegistry.inspect().phase, "admissions_closed"); return context(fixture); },
    (fixture: ReturnType<typeof runtimeFixtureWithHooks>) => { fixture.decisionRegistry.consumeForAct({ principal: "principal-red", runId: "run-1", worldInstanceId: "instance-1", token: fixture.red.token, atTick: 0 }); fixture.decisionRegistry.consumeForAct({ principal: "principal-blue", runId: "run-1", worldInstanceId: "instance-1", token: fixture.blue.token, atTick: 0 }); fixture.decisionRegistry.beginCutoff(0); fixture.decisionRegistry.closeAdmissions(0); fixture.decisionRegistry.finalize(0); assert.equal(fixture.decisionRegistry.inspect().phase, "finalized"); return context(fixture); },
  ];
  for (const prepare of cases) {
    let calls = 0; const fixture = runtimeFixtureWithHooks({ observe: () => { calls += 1; return { channels: [] }; }, project: () => { calls += 1; return { channels: [] }; }, available: () => { calls += 1; return true; } });
    const request = prepare(fixture); const decision = fixture.decisionRegistry.snapshot(); const dynamics = fixture.dynamics.snapshot(); denied(() => fixture.runtime!.affordances(request));
    assert.equal(calls, 0); assert.deepEqual(fixture.decisionRegistry.snapshot(), decision); assert.deepEqual(fixture.dynamics.snapshot(), dynamics);
    assert.deepEqual(fixture.readLedger.read(request.principal, {}).records.map((record) => [record.operation, record.result]), [["affordances", "denied"]]);
  }
});
