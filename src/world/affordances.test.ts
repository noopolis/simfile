import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalDynamicsJson } from "../dynamics/canonicalJson.js";
import { DYNAMICS_ACTION_RETENTION_LIMITS, DYNAMICS_LIMITS } from "../dynamics/limits.js";
import type { DynamicsSession } from "../dynamics/session.js";
import { WorldRuntimeError } from "./ledger.js";
import { runtimeFixture, runtimeFixtureWithHooks } from "./runtime.test-helper.js";

const denied = (call: () => unknown): void => assert.throws(call, (error: unknown) =>
  error instanceof WorldRuntimeError && error.code === "world_runtime_denied");
const action = (id: string) => ({ act_id: id, action: "wait", actor: "object:red", at_tick: 0,
  input: {}, origin: "test", principal_id: "principal-red", target: "object:red" });
const snapshotBytes = (dynamics: DynamicsSession): Buffer => Buffer.from(JSON.stringify(dynamics.snapshot()));
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const fillRetainedIngress = (dynamics: DynamicsSession): void => {
  for (let index = 0; index < DYNAMICS_ACTION_RETENTION_LIMITS.records; index += 1) {
    const suffix = index.toString().padStart(4, "0");
    const identifier = `${"\0".repeat(DYNAMICS_LIMITS.identifier_code_units - suffix.length)}${suffix}`;
    const receipt = dynamics.queueAction({
      act_id: identifier,
      action: "wait",
      actor: "object:red",
      at_tick: 1,
      input: {},
      origin: "agentic",
      principal_id: identifier,
      target: "object:red",
    });
    assert.equal(receipt.queued, false);
  }
};

test("reports only each principal's granted available affordances in frozen canonical bytes", () => {
  const fixture = runtimeFixture();
  const before = fixture.dynamics.snapshot();
  const red = fixture.runtime.affordances({ principal: "principal-red", decisionToken: fixture.red.token });
  const blue = fixture.runtime.affordances({ principal: "principal-blue", decisionToken: fixture.blue.token });
  assert.deepEqual(red.affordances, [
    { address: "world://pitch/affordance/kick", targets: ["world://pitch/entity/ball"] },
    { address: "world://pitch/affordance/wait", targets: ["world://pitch/entity/red"] },
  ]);
  assert.deepEqual(blue.affordances, [{ address: "world://pitch/affordance/wait", targets: ["world://pitch/entity/blue"] }]);
  assert.ok(Object.isFrozen(red));
  assert.ok(Object.isFrozen(red.affordances));
  assert.ok(Object.isFrozen(red.affordances[0]!.targets));
  assert.equal(JSON.stringify(red).includes("sense:state"), false);
  assert.equal(JSON.stringify(red).includes(fixture.red.token), false);
  assert.deepEqual(fixture.dynamics.snapshot(), before);
  assert.deepEqual(fixture.readLedger.read("principal-red", {}).records.map((record) => [record.operation, record.result]), [["affordances", "allowed"]]);
});

test("keeps repeated successful availability reads decision- and session-pure", () => {
  let providers = 0; let projections = 0; let availability = 0;
  const fixture = runtimeFixtureWithHooks({
    observe: (input) => { providers += 1; return { channels: [{ components: { x: 1 }, sense_address: (input as { sense_addresses: readonly string[] }).sense_addresses[0]!, subject_address: "object:red" }] }; },
    project: (input) => { projections += 1; return { channels: input.observation.channels.map((channel) => ({ ...channel, sense_address: "sense:vision", subject_address: "entity:red" })) }; },
    available: () => { availability += 1; return true; },
  }, true, { runId: "run-1", worldInstanceId: "instance-1", redSenses: ["world://pitch/sense/vision"], redAffordances: ["world://pitch/affordance/wait"] });
  const decisions = fixture.decisionRegistry.snapshot();
  const session = fixture.dynamics.snapshot();
  const first = fixture.runtime!.affordances({ principal: "principal-red", decisionToken: fixture.red.token });
  const second = fixture.runtime!.affordances({ principal: "principal-red", decisionToken: fixture.red.token });
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  assert.notEqual(first.affordances, second.affordances);
  assert.deepEqual([providers, projections, availability], [2, 2, 2]);
  assert.deepEqual(fixture.decisionRegistry.snapshot(), decisions);
  assert.deepEqual(fixture.dynamics.snapshot(), session);
  assert.deepEqual(fixture.readLedger.read("principal-red", {}).records.map((record) => record.result), ["allowed", "allowed"]);
});

test("collects every granted sense into a source-isolated frozen availability observation", () => {
  const providers: unknown[] = [];
  const availability: unknown[] = [];
  const fixture = runtimeFixtureWithHooks({
    observe: (input) => {
      providers.push(input);
      const sense = (input as { sense_addresses: readonly string[] }).sense_addresses[0]!;
      return { channels: [{ components: { x: sense === "sense:state" ? 7 : 9 }, sense_address: sense, subject_address: "object:red" }] };
    },
    project: (input) => ({ channels: input.observation.channels.map((channel) => ({ components: channel.components, sense_address: "sense:vision", subject_address: "entity:red" })) }),
    available: (input) => { availability.push(input); return input.observation.channels.some((channel) => channel.components.x === 7); },
  });
  const result = fixture.runtime!.affordances({ principal: "principal-red", decisionToken: fixture.red.token });
  assert.deepEqual(providers.map((input) => (input as { sense_addresses: readonly string[] }).sense_addresses), [["sense:detail"], ["sense:state"]]);
  assert.equal(availability.length, 2);
  assert.deepEqual((availability[0] as { observation: { channels: unknown[] } }).observation.channels.map((channel) => (channel as { components: { x: number } }).components.x), [9, 7]);
  assert.ok(Object.isFrozen(availability[0]));
  assert.deepEqual(result.affordances.map((affordance) => affordance.address), ["world://pitch/affordance/kick", "world://pitch/affordance/wait"]);
});

test("retains mixed fixed targets, omits all-false affordances, and keeps selector order canonical", () => {
  const targets: string[] = [];
  const fixture = runtimeFixtureWithHooks({
    available: (input) => { targets.push(input.target); return input.target === "entity:blue" || input.target === "entity:red"; },
  }, true, { runId: "run-1", worldInstanceId: "instance-1", fixedTargets: ["entity:blue", "entity:ball"] });
  const result = fixture.runtime!.affordances({ principal: "principal-red", decisionToken: fixture.red.token });
  assert.deepEqual(targets, ["entity:ball", "entity:blue", "entity:red"]);
  assert.deepEqual(result.affordances, [
    { address: "world://pitch/affordance/kick", targets: ["world://pitch/entity/blue"] },
    { address: "world://pitch/affordance/wait", targets: ["world://pitch/entity/red"] },
  ]);
  const none = runtimeFixtureWithHooks({ available: () => false });
  assert.deepEqual(none.runtime!.affordances({ principal: "principal-red", decisionToken: none.red.token }).affordances, []);
});

test("uses the exact empty checked observation and no callbacks for an empty affordance grant", () => {
  let providers = 0;
  let callbacks = 0;
  const empty = runtimeFixtureWithHooks({ observe: () => { providers += 1; return { channels: [] }; }, available: () => { callbacks += 1; return true; } }, true,
    { runId: "run-1", worldInstanceId: "instance-1", redAffordances: [] });
  assert.deepEqual(empty.runtime!.affordances({ principal: "principal-red", decisionToken: empty.red.token }).affordances, []);
  assert.equal(providers, 0);
  assert.equal(callbacks, 0);
  let seen: unknown;
  const noSenses = runtimeFixtureWithHooks({ available: (input) => { seen = input.observation; return true; } }, true,
    { runId: "run-1", worldInstanceId: "instance-1", redSenses: [], redAffordances: ["world://pitch/affordance/wait"] });
  noSenses.runtime!.affordances({ principal: "principal-red", decisionToken: noSenses.red.token });
  assert.deepEqual(JSON.parse(JSON.stringify(seen)), { channels: [] });
  assert.ok(Object.isFrozen(seen));
});

test("denies aggregate public observations over the channel bound before availability", () => {
  let available = 0;
  const channels = (sense: string, count: number) => Array.from({ length: count }, (_, index) => ({ components: { x: index }, frame: `frame:f${index}`, sense_address: sense, subject_address: "entity:red" }));
  const fixture = runtimeFixtureWithHooks({
    project: () => ({ channels: channels("sense:vision", 129) }),
    projectDetail: () => ({ channels: channels("sense:red-detail", 128) }),
    available: () => { available += 1; return true; },
  });
  const before = fixture.dynamics.snapshot();
  denied(() => fixture.runtime!.affordances({ principal: "principal-red", decisionToken: fixture.red.token }));
  assert.equal(available, 0);
  assert.deepEqual(fixture.dynamics.snapshot(), before);
});

test("denies duplicate aggregate channels before availability", () => {
  let available = 0;
  const fixture = runtimeFixtureWithHooks({
    project: () => ({ channels: [{ components: { x: 1 }, sense_address: "sense:shared", subject_address: "entity:red" }] }),
    projectDetail: () => ({ channels: [{ components: { x: 1 }, sense_address: "sense:shared", subject_address: "entity:red" }] }),
    available: () => { available += 1; return true; },
  });
  const before = fixture.dynamics.snapshot();
  denied(() => fixture.runtime!.affordances({ principal: "principal-red", decisionToken: fixture.red.token }));
  assert.equal(available, 0);
  assert.deepEqual(fixture.dynamics.snapshot(), before);
});

test("denies hostile availability callbacks and restores the complete outer session checkpoint", () => {
  const hostile = [
    (_dynamics: DynamicsSession) => { throw new Error("available"); },
    (_dynamics: DynamicsSession) => Promise.resolve(true),
    (_dynamics: DynamicsSession) => "true",
    (dynamics: DynamicsSession) => { dynamics.queueAction(action("available-true")); return true; },
    (dynamics: DynamicsSession) => { dynamics.queueAction(action("available-false")); return false; },
    (dynamics: DynamicsSession) => { dynamics.queueAction(action("available-throw")); throw new Error("available"); },
    (dynamics: DynamicsSession) => { dynamics.queueAction(action("available-promise")); return Promise.resolve(false); },
    (dynamics: DynamicsSession) => { dynamics.queueAction(action("available-malformed")); return {}; },
    (dynamics: DynamicsSession) => { dynamics.step(); return true; },
  ];
  for (const available of hostile) {
    const fixture = runtimeFixtureWithHooks({ available: (_input, dynamics) => available(dynamics) });
    const before = fixture.dynamics.snapshot();
    denied(() => fixture.runtime!.affordances({ principal: "principal-red", decisionToken: fixture.red.token }));
    assert.deepEqual(fixture.dynamics.snapshot(), before);
    assert.deepEqual(fixture.readLedger.read("principal-red", {}).records.map((record) => [record.operation, record.result]), [["affordances", "denied"]]);
  }
});

test("keeps overflow-sized affordance failures byte-pure without normalizing retained receipts", () => {
  const subject = runtimeFixtureWithHooks({ available: () => { throw new Error("available"); } });
  const control = runtimeFixtureWithHooks({ available: () => { throw new Error("available"); } });
  fillRetainedIngress(subject.dynamics);
  fillRetainedIngress(control.dynamics);
  const before = snapshotBytes(subject.dynamics);
  assert.throws(() => canonicalDynamicsJson(subject.dynamics.snapshot()), /json_code_units|json nodes|JSON/u);
  assert.deepEqual(
    Object.keys(subject.dynamics.snapshot().action_ingress[0]!.receipt),
    ["act_id", "apply_tick", "code", "queued"],
  );
  denied(() => subject.runtime!.affordances({ principal: "principal-red", decisionToken: subject.red.token }));
  const after = snapshotBytes(subject.dynamics);
  assert.deepEqual(after, before);
  assert.equal(digest(after), digest(before));
  assert.equal(subject.restoreCalls(), 0);
  assert.deepEqual(
    Object.keys(subject.dynamics.snapshot().action_ingress[0]!.receipt),
    ["act_id", "apply_tick", "code", "queued"],
  );
  assert.deepEqual(subject.dynamics.step(), control.dynamics.step());
  const subjectAfterStep = snapshotBytes(subject.dynamics);
  const controlAfterStep = snapshotBytes(control.dynamics);
  assert.deepEqual(subjectAfterStep, controlAfterStep);
  assert.equal(digest(subjectAfterStep), digest(controlAfterStep));
});

test("denies terminal admissions before provider, projection, or availability callbacks", () => {
  const cases = [
    { phase: undefined, prepare: (fixture: ReturnType<typeof runtimeFixtureWithHooks>) => ({ token: fixture.blue.token }) },
    { phase: undefined, prepare: (fixture: ReturnType<typeof runtimeFixtureWithHooks>) => { fixture.dynamics.step(); fixture.dynamics.step(); fixture.dynamics.step(); return { token: fixture.red.token }; } },
    { phase: undefined, prepare: (fixture: ReturnType<typeof runtimeFixtureWithHooks>) => { fixture.decisionRegistry.consumeForAct({ principal: "principal-red", runId: "run-1", worldInstanceId: "instance-1", token: fixture.red.token, atTick: 0 }); return { token: fixture.red.token }; } },
    { phase: "admissions_closed", prepare: (fixture: ReturnType<typeof runtimeFixtureWithHooks>) => { fixture.decisionRegistry.consumeForAct({ principal: "principal-red", runId: "run-1", worldInstanceId: "instance-1", token: fixture.red.token, atTick: 0 }); fixture.decisionRegistry.consumeForAct({ principal: "principal-blue", runId: "run-1", worldInstanceId: "instance-1", token: fixture.blue.token, atTick: 0 }); fixture.decisionRegistry.beginCutoff(0); fixture.decisionRegistry.closeAdmissions(0); assert.equal(fixture.decisionRegistry.inspect().phase, "admissions_closed"); return { token: fixture.red.token }; } },
    { phase: "finalized", prepare: (fixture: ReturnType<typeof runtimeFixtureWithHooks>) => { fixture.decisionRegistry.consumeForAct({ principal: "principal-red", runId: "run-1", worldInstanceId: "instance-1", token: fixture.red.token, atTick: 0 }); fixture.decisionRegistry.consumeForAct({ principal: "principal-blue", runId: "run-1", worldInstanceId: "instance-1", token: fixture.blue.token, atTick: 0 }); fixture.decisionRegistry.beginCutoff(0); fixture.decisionRegistry.closeAdmissions(0); fixture.decisionRegistry.finalize(0); assert.equal(fixture.decisionRegistry.inspect().phase, "finalized"); return { token: fixture.red.token }; } },
  ];
  for (const entry of cases) {
    let calls = 0;
    const fixture = runtimeFixtureWithHooks({ observe: () => { calls += 1; return { channels: [] }; }, project: () => { calls += 1; return { channels: [] }; }, available: () => { calls += 1; return true; } });
    const context = entry.prepare(fixture);
    denied(() => fixture.runtime!.affordances({ principal: "principal-red", decisionToken: context.token }));
    assert.equal(calls, 0);
  }
});

test("keeps availability reentry to one nested denial and one outer audit, and filters the ledger", () => {
  let caughtCounts = [0, 0, 0];
  let caught: ReturnType<typeof runtimeFixtureWithHooks>;
  caught = runtimeFixtureWithHooks({ observe: (input) => { caughtCounts[0] += 1; return { channels: [{ components: { x: 1 }, sense_address: (input as { sense_addresses: readonly string[] }).sense_addresses[0]!, subject_address: "object:red" }] }; }, project: (input) => { caughtCounts[1] += 1; return { channels: input.observation.channels.map((channel) => ({ ...channel, sense_address: "sense:vision", subject_address: "entity:red" })) }; }, available: () => { caughtCounts[2] += 1; try { caught.runtime!.affordances({ principal: "principal-red", decisionToken: caught.red.token }); } catch { /* Nested call is denied. */ } return true; } }, true, { runId: "run-1", worldInstanceId: "instance-1", redSenses: ["world://pitch/sense/vision"], redAffordances: ["world://pitch/affordance/wait"] });
  const caughtState = caught.dynamics.snapshot();
  caught.runtime!.affordances({ principal: "principal-red", decisionToken: caught.red.token });
  assert.deepEqual(caughtCounts, [1, 1, 1]); assert.deepEqual(caught.dynamics.snapshot(), caughtState);
  assert.deepEqual(caught.readLedger.read("principal-red", { operations: ["affordances"] }).records.map((record) => [record.operation, record.result]), [["affordances", "denied"], ["affordances", "allowed"]]);
  const uncaughtCounts = [0, 0, 0]; let uncaught: ReturnType<typeof runtimeFixtureWithHooks>;
  uncaught = runtimeFixtureWithHooks({ observe: (input) => { uncaughtCounts[0] += 1; return { channels: [{ components: { x: 1 }, sense_address: (input as { sense_addresses: readonly string[] }).sense_addresses[0]!, subject_address: "object:red" }] }; }, project: (input) => { uncaughtCounts[1] += 1; return { channels: input.observation.channels.map((channel) => ({ ...channel, sense_address: "sense:vision", subject_address: "entity:red" })) }; }, available: () => { uncaughtCounts[2] += 1; return uncaught.runtime!.affordances({ principal: "principal-red", decisionToken: uncaught.red.token }) as never; } }, true, { runId: "run-1", worldInstanceId: "instance-1", redSenses: ["world://pitch/sense/vision"], redAffordances: ["world://pitch/affordance/wait"] });
  const uncaughtState = uncaught.dynamics.snapshot();
  denied(() => uncaught.runtime!.affordances({ principal: "principal-red", decisionToken: uncaught.red.token }));
  assert.deepEqual(uncaughtCounts, [1, 1, 1]); assert.deepEqual(uncaught.dynamics.snapshot(), uncaughtState);
  assert.deepEqual(uncaught.readLedger.read("principal-red", {}).records.map((record) => [record.operation, record.result]), [["affordances", "denied"], ["affordances", "denied"]]);
});

test("keeps provider and projection affordance reentry caught or uncaught before another callback", () => {
  const options = { runId: "run-1", worldInstanceId: "instance-1", redAffordances: ["world://pitch/affordance/wait"] as const, redSenses: ["world://pitch/sense/vision"] as const };
  const providerCounts = [0, 0, 0]; let caughtProvider: ReturnType<typeof runtimeFixtureWithHooks>;
  caughtProvider = runtimeFixtureWithHooks({ observe: (input) => { providerCounts[0] += 1; try { caughtProvider.runtime!.affordances({ principal: "principal-red", decisionToken: caughtProvider.red.token }); } catch { /* Nested call is denied. */ } return { channels: [{ components: { x: 1 }, sense_address: (input as { sense_addresses: readonly string[] }).sense_addresses[0]!, subject_address: "object:red" }] }; }, project: (input) => { providerCounts[1] += 1; return { channels: input.observation.channels.map((channel) => ({ ...channel, sense_address: "sense:vision", subject_address: "entity:red" })) }; }, available: () => { providerCounts[2] += 1; return true; } }, true, options);
  const providerState = caughtProvider.dynamics.snapshot();
  caughtProvider.runtime!.affordances({ principal: "principal-red", decisionToken: caughtProvider.red.token });
  assert.deepEqual(providerCounts, [1, 1, 1]); assert.deepEqual(caughtProvider.dynamics.snapshot(), providerState);
  assert.deepEqual(caughtProvider.readLedger.read("principal-red", {}).records.map((record) => record.result), ["denied", "allowed"]);
  const uncaughtProviderCounts = [0, 0, 0]; let uncaughtProvider: ReturnType<typeof runtimeFixtureWithHooks>;
  uncaughtProvider = runtimeFixtureWithHooks({ observe: () => { uncaughtProviderCounts[0] += 1; return uncaughtProvider.runtime!.affordances({ principal: "principal-red", decisionToken: uncaughtProvider.red.token }) as never; }, project: () => { uncaughtProviderCounts[1] += 1; return { channels: [] }; }, available: () => { uncaughtProviderCounts[2] += 1; return true; } }, true, options);
  const uncaughtProviderState = uncaughtProvider.dynamics.snapshot();
  denied(() => uncaughtProvider.runtime!.affordances({ principal: "principal-red", decisionToken: uncaughtProvider.red.token }));
  assert.deepEqual(uncaughtProviderCounts, [1, 0, 0]); assert.deepEqual(uncaughtProvider.dynamics.snapshot(), uncaughtProviderState);
  assert.deepEqual(uncaughtProvider.readLedger.read("principal-red", {}).records.map((record) => record.result), ["denied", "denied"]);
  const projectionCounts = [0, 0, 0]; let caughtProjection: ReturnType<typeof runtimeFixtureWithHooks>;
  caughtProjection = runtimeFixtureWithHooks({ observe: (input) => { projectionCounts[0] += 1; return { channels: [{ components: { x: 1 }, sense_address: (input as { sense_addresses: readonly string[] }).sense_addresses[0]!, subject_address: "object:red" }] }; }, project: (input) => { projectionCounts[1] += 1; try { caughtProjection.runtime!.affordances({ principal: "principal-red", decisionToken: caughtProjection.red.token }); } catch { /* Nested call is denied. */ } return { channels: input.observation.channels.map((channel) => ({ components: channel.components, sense_address: "sense:vision", subject_address: "entity:red" })) }; }, available: () => { projectionCounts[2] += 1; return true; } }, true, options);
  const projectionState = caughtProjection.dynamics.snapshot();
  caughtProjection.runtime!.affordances({ principal: "principal-red", decisionToken: caughtProjection.red.token });
  assert.deepEqual(projectionCounts, [1, 1, 1]); assert.deepEqual(caughtProjection.dynamics.snapshot(), projectionState);
  assert.deepEqual(caughtProjection.readLedger.read("principal-red", {}).records.map((record) => record.result), ["denied", "allowed"]);
  const uncaughtProjectionCounts = [0, 0, 0]; let uncaughtProjection: ReturnType<typeof runtimeFixtureWithHooks>;
  uncaughtProjection = runtimeFixtureWithHooks({ observe: (input) => { uncaughtProjectionCounts[0] += 1; return { channels: [{ components: { x: 1 }, sense_address: (input as { sense_addresses: readonly string[] }).sense_addresses[0]!, subject_address: "object:red" }] }; }, project: () => { uncaughtProjectionCounts[1] += 1; return uncaughtProjection.runtime!.affordances({ principal: "principal-red", decisionToken: uncaughtProjection.red.token }) as never; }, available: () => { uncaughtProjectionCounts[2] += 1; return true; } }, true, options);
  const uncaughtProjectionState = uncaughtProjection.dynamics.snapshot();
  denied(() => uncaughtProjection.runtime!.affordances({ principal: "principal-red", decisionToken: uncaughtProjection.red.token }));
  assert.deepEqual(uncaughtProjectionCounts, [1, 1, 0]); assert.deepEqual(uncaughtProjection.dynamics.snapshot(), uncaughtProjectionState);
  assert.deepEqual(uncaughtProjection.readLedger.read("principal-red", {}).records.map((record) => record.result), ["denied", "denied"]);
});
