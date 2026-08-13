import assert from "node:assert/strict";
import test from "node:test";

import type { DynamicsSession } from "../dynamics/session.js";
import { runtimeActionJournalSnapshot, runtimeActEnvelope, runtimeFixtureWithHooks } from "./runtime.test-helper.js";
import { readWorldRuntimeClockAuthority } from "./clockAuthority.js";
import type { WorldActIngressRejectionReason } from "./actTypes.js";

const denied = (reason: WorldActIngressRejectionReason, fieldPath?: string) => Object.freeze({
  disposition: "rejected_at_ingress" as const,
  code: "world_action_denied" as const,
  reason,
  ...(fieldPath === undefined ? {} : { field_path: fieldPath }),
});
const request = { affordance: "world://pitch/affordance/kick", target: "world://pitch/entity/ball", input: { force: 1 } };
const context = (token: string) => ({ principal: "principal-red", decisionToken: token });
const envelope = (requestId: string) => runtimeActEnvelope(requestId, request);
const mechanicsObservation = (input?: unknown) => {
  const addresses = input !== null && typeof input === "object" && Array.isArray((input as { sense_addresses?: unknown }).sense_addresses)
    ? (input as { sense_addresses: readonly unknown[] }).sense_addresses.filter((address): address is string => typeof address === "string")
    : ["sense:state"];
  return { channels: addresses.map((sense_address) => ({ components: { x: 1 }, sense_address, subject_address: "object:red" })) };
};
const projectedObservation = (input: { readonly observation: { readonly channels: readonly { readonly components: Readonly<Record<string, number>>; readonly unit?: string }[] } }) => ({
  channels: input.observation.channels.map((channel) => ({ components: channel.components, sense_address: "sense:vision", subject_address: "entity:red", ...(channel.unit === undefined ? {} : { unit: channel.unit }) })),
});
const probe = (id: string) => ({ act_id: id, action: "probe", actor: "object:red", at_tick: 0, input: {}, origin: "agentic", principal_id: "principal-red", target: "object:red" });

type Fixture = ReturnType<typeof runtimeFixtureWithHooks>;
type Behavior = (fixture: Fixture, dynamics: DynamicsSession, nestedResults: unknown[]) => unknown;

const assertDeniedAndRestored = (
  fixture: Fixture,
  reason: WorldActIngressRejectionReason,
  fieldPath?: string,
  name?: string,
): void => {
  const beforeDynamics = fixture.dynamics.snapshot();
  const beforeDecision = fixture.decisionRegistry.snapshot();
  assert.deepEqual(fixture.runtime!.act(context(fixture.red.token), envelope("denied-action")), denied(reason, fieldPath), name);
  assert.equal(fixture.dynamics.nextTick, beforeDynamics.next_tick);
  assert.deepEqual(fixture.dynamics.snapshot(), beforeDynamics);
  assert.deepEqual(fixture.decisionRegistry.snapshot(), beforeDecision);
  const journal = runtimeActionJournalSnapshot(fixture.runtime);
  assert.ok(journal);
  assert.deepEqual(journal.cells, []);
  assert.ok(journal.audits.length >= 1);
  assert.ok(journal.audits.every((audit) => audit.principal === "principal-red" && audit.result === "denied"));
};

const queueAfterDenial = (fixture: Fixture): void => {
  const receipt = fixture.runtime!.act(context(fixture.red.token), envelope("queued-after-denial"));
  assert.equal(receipt.disposition, "queued");
  assert.equal(fixture.dynamics.snapshot().pending_actions.length, 1);
  assert.equal(runtimeActionJournalSnapshot(fixture.runtime)!.cells.length, 1);
};

const observeCases: readonly { readonly name: string; readonly expectedCalls: number; readonly reason: WorldActIngressRejectionReason; readonly behavior: Behavior }[] = [
  { name: "provider throws", expectedCalls: 1, reason: "world_surface_failed", behavior: () => { throw new Error("observe"); } },
  { name: "provider returns a thenable", expectedCalls: 1, reason: "world_surface_failed", behavior: () => ({ then: () => {} }) },
  { name: "provider returns malformed observation", expectedCalls: 1, reason: "world_surface_failed", behavior: () => ({}) },
  {
    name: "provider queues a real action and is restored", expectedCalls: 1, reason: "world_surface_failed",
    behavior: (_fixture, dynamics) => { dynamics.queueAction(probe("observe-mutation")); return mechanicsObservation(); },
  },
  {
    name: "provider advances the real tick and is restored", expectedCalls: 1, reason: "world_surface_failed",
    behavior: (_fixture, dynamics) => { dynamics.step(); return mechanicsObservation(); },
  },
  {
    name: "caught nested act reentry", expectedCalls: 1, reason: "world_surface_failed",
      behavior: (fixture, _dynamics, nestedResults) => { nestedResults.push(fixture.runtime!.act(context(fixture.red.token), envelope("nested-observe"))); return mechanicsObservation(); },
  },
  {
    name: "uncaught nested act reentry", expectedCalls: 1, reason: "world_surface_failed",
      behavior: (fixture, _dynamics, nestedResults) => { nestedResults.push(fixture.runtime!.act(context(fixture.red.token), envelope("nested-observe-uncaught"))); throw new Error("uncaught reentry"); },
  },
];

test("act aggregates hostile provider observations through the real session", () => {
  for (const item of observeCases) {
    let first = true;
    let calls = 0;
    const nestedResults: unknown[] = [];
    let fixture!: Fixture;
    fixture = runtimeFixtureWithHooks({
      observe: (input) => {
        calls += 1;
        if (first) { first = false; return item.behavior(fixture, fixture.dynamics, nestedResults); }
        return mechanicsObservation(input);
      },
    });
    assertDeniedAndRestored(fixture, item.reason, undefined, item.name);
    assert.equal(calls, item.expectedCalls, item.name);
    if (item.name.includes("nested act")) {
      assert.equal(nestedResults.length, 1, item.name);
      assert.deepEqual(nestedResults[0], denied("ingress_reentered"));
    }
    queueAfterDenial(fixture);
  }
});

const projectionCases: readonly { readonly name: string; readonly expectedCalls: number; readonly reason: WorldActIngressRejectionReason; readonly behavior: Behavior }[] = [
  { name: "projection throws", expectedCalls: 1, reason: "world_surface_failed", behavior: () => { throw new Error("projection"); } },
  { name: "projection returns a thenable", expectedCalls: 1, reason: "world_surface_failed", behavior: () => ({ then: () => {} }) },
  { name: "projection returns malformed output", expectedCalls: 1, reason: "world_surface_failed", behavior: () => ({}) },
  {
    name: "projection queues a real action and is restored", expectedCalls: 1, reason: "world_surface_failed",
    behavior: (_fixture, dynamics) => { dynamics.queueAction(probe("projection-mutation")); return undefined; },
  },
  {
    name: "projection advances the real tick and is restored", expectedCalls: 1, reason: "world_surface_failed",
    behavior: (_fixture, dynamics) => { dynamics.step(); return undefined; },
  },
  {
    name: "caught nested act reentry", expectedCalls: 1, reason: "ingress_reentered",
      behavior: (fixture, _dynamics, nestedResults) => { nestedResults.push(fixture.runtime!.act(context(fixture.red.token), envelope("nested-project"))); return undefined; },
  },
  {
    name: "uncaught nested act reentry", expectedCalls: 1, reason: "world_surface_failed",
      behavior: (fixture, _dynamics, nestedResults) => { nestedResults.push(fixture.runtime!.act(context(fixture.red.token), envelope("nested-project-uncaught"))); throw new Error("uncaught reentry"); },
  },
];

test("act uses checked sense projections before admission", () => {
  for (const item of projectionCases) {
    let first = true;
    let calls = 0;
    const nestedResults: unknown[] = [];
    let fixture!: Fixture;
    fixture = runtimeFixtureWithHooks({
      project: (input) => {
        calls += 1;
        if (first) { first = false; const result = item.behavior(fixture, fixture.dynamics, nestedResults); if (result !== undefined) return result; }
        return projectedObservation(input);
      },
    });
    assertDeniedAndRestored(fixture, item.reason, undefined, item.name);
    assert.equal(calls, item.expectedCalls, item.name);
    if (item.name.includes("nested act")) {
      assert.equal(nestedResults.length, 1, item.name);
      assert.deepEqual(nestedResults[0], denied("ingress_reentered"));
    }
    queueAfterDenial(fixture);
  }
});

const availabilityCases: readonly { readonly name: string; readonly reason: WorldActIngressRejectionReason; readonly behavior: Behavior }[] = [
  { name: "false", reason: "affordance_unavailable", behavior: () => false },
  { name: "throws", reason: "world_surface_failed", behavior: () => { throw new Error("availability"); } },
  { name: "returns a thenable", reason: "world_surface_failed", behavior: () => ({ then: () => {} }) },
  { name: "returns malformed output", reason: "world_surface_failed", behavior: () => "true" },
  {
    name: "caught nested act reentry", reason: "ingress_reentered",
    behavior: (fixture, _dynamics, nestedResults) => { nestedResults.push(fixture.runtime!.act(context(fixture.red.token), envelope("nested-available"))); return true; },
  },
  { name: "uncaught nested act reentry", reason: "world_surface_failed", behavior: (fixture, _dynamics, nestedResults) => { nestedResults.push(fixture.runtime!.act(context(fixture.red.token), envelope("nested-available-uncaught"))); throw new Error("uncaught reentry"); } },
  { name: "queues a real action and is restored", reason: "world_state_unstable", behavior: (_fixture, dynamics) => { dynamics.queueAction(probe("availability-mutation")); return true; } },
  { name: "advances the real tick and is restored", reason: "world_state_unstable", behavior: (_fixture, dynamics) => { dynamics.step(); return true; } },
];

test("availability is one callback, rollback-safe, and before lowering", () => {
  for (const item of availabilityCases) {
    let first = true;
    let calls = 0;
    const nestedResults: unknown[] = [];
    let fixture!: Fixture;
    fixture = runtimeFixtureWithHooks({
      available: () => {
        calls += 1;
        if (first) { first = false; return item.behavior(fixture, fixture.dynamics, nestedResults); }
        return true;
      },
    });
    assertDeniedAndRestored(fixture, item.reason, undefined, item.name);
    assert.equal(calls, 1, item.name);
    if (item.name.includes("nested act")) {
      assert.equal(nestedResults.length, 1, item.name);
      assert.deepEqual(nestedResults[0], denied("ingress_reentered"));
    }
    queueAfterDenial(fixture);
  }
});

test("typed schema validation precedes lower", () => {
  let lowerCalls = 0;
  const fixture = runtimeFixtureWithHooks({ lower: () => { lowerCalls += 1; return { force: 1 }; } });
  const before = fixture.dynamics.snapshot();
  const beforeDecision = fixture.decisionRegistry.snapshot();
  assert.deepEqual(fixture.runtime!.act(context(fixture.red.token), runtimeActEnvelope("invalid-schema", { ...request, input: { force: 2 } })), denied("action_input_out_of_bounds", "force"));
  assert.equal(lowerCalls, 0);
  assert.deepEqual(fixture.dynamics.snapshot(), before);
  assert.deepEqual(fixture.decisionRegistry.snapshot(), beforeDecision);
  const journal = runtimeActionJournalSnapshot(fixture.runtime);
  assert.ok(journal);
  assert.deepEqual(journal.cells, []);
  assert.deepEqual(journal.audits, [{ principal: "principal-red", result: "denied" }]);
  queueAfterDenial(fixture);
});

const loweringCases: readonly { readonly name: string; readonly reason: WorldActIngressRejectionReason; readonly behavior: Behavior }[] = [
  { name: "throws", reason: "world_surface_failed", behavior: () => { throw new Error("lower"); } },
  { name: "returns a thenable", reason: "world_surface_failed", behavior: () => ({ then: () => {} }) },
  { name: "returns malformed output", reason: "world_surface_failed", behavior: () => [] },
  { name: "returns reserved output", reason: "internal_error", behavior: () => ({ receipt_id: "forbidden" }) },
  { name: "caught nested act reentry", reason: "ingress_reentered", behavior: (fixture, _dynamics, nestedResults) => { nestedResults.push(fixture.runtime!.act(context(fixture.red.token), envelope("nested-lower"))); return { force: 1 }; } },
  { name: "uncaught nested act reentry", reason: "world_surface_failed", behavior: (fixture, _dynamics, nestedResults) => { nestedResults.push(fixture.runtime!.act(context(fixture.red.token), envelope("nested-lower-uncaught"))); throw new Error("uncaught reentry"); } },
  { name: "queues a real action and is restored", reason: "world_state_unstable", behavior: (_fixture, dynamics) => { dynamics.queueAction(probe("lower-mutation")); return { force: 1 }; } },
  { name: "advances the real tick and is restored", reason: "world_state_unstable", behavior: (_fixture, dynamics) => { dynamics.step(); return { force: 1 }; } },
];

test("checked lowering failures deny without consuming the original token", () => {
  for (const item of loweringCases) {
    let first = true;
    let calls = 0;
    const nestedResults: unknown[] = [];
    let fixture!: Fixture;
    fixture = runtimeFixtureWithHooks({
      lower: () => {
        calls += 1;
        if (first) { first = false; return item.behavior(fixture, fixture.dynamics, nestedResults); }
        return { force: 1 };
      },
    });
    assertDeniedAndRestored(fixture, item.reason, undefined, item.name);
    assert.equal(calls, 1, item.name);
    if (item.name.includes("nested act")) {
      assert.equal(nestedResults.length, 1, item.name);
      assert.deepEqual(nestedResults[0], denied("ingress_reentered"));
    }
    queueAfterDenial(fixture);
  }
});

test("a successful admission queues once and commits one real terminal cell", () => {
  let lowerCalls = 0;
  let projectionResultCalls = 0;
  const fixture = runtimeFixtureWithHooks({
    lower: () => { lowerCalls += 1; return { force: 1 }; },
    projectResult: () => { projectionResultCalls += 1; return { outcome: true }; },
    step: (input) => {
      const actions = (input as { readonly actions: readonly { readonly sequence: number }[] }).actions;
      return { tick: 0, events: [], action_results: actions.map((queued) => ({ accepted: true, sequence: queued.sequence })) };
    },
  });
  const receipt = fixture.runtime!.act(context(fixture.red.token), envelope("successful-action"));
  assert.equal(receipt.disposition, "queued");
  assert.equal(lowerCalls, 1);
  assert.equal(fixture.dynamics.snapshot().pending_actions.length, 1);
  assert.equal(fixture.dynamics.snapshot().action_ingress.length, 1);
  const queued = runtimeActionJournalSnapshot(fixture.runtime)!;
  assert.equal(queued.cells.length, 1);
  assert.equal(queued.cells[0]!.state, "authorized");
  assert.equal(queued.cells[0]!.terminal, null);
  assert.deepEqual(readWorldRuntimeClockAuthority(fixture.runtime)!.stepDynamics(), { tick: 0, action_results: 1, events: 0 });
  assert.equal(fixture.dynamics.nextTick, 1);
  assert.equal(projectionResultCalls, 1);
  const applied = runtimeActionJournalSnapshot(fixture.runtime)!;
  assert.equal(applied.cells.length, 1);
  assert.equal(applied.cells[0]!.state, "terminal");
  assert.equal(applied.cells[0]!.terminal?.disposition, "applied");
  assert.equal(applied.cells[0]!.terminal?.projection, "projected");
  assert.equal(applied.cells[0]!.terminal?.effect?.outcome, true);
});
