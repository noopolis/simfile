import assert from "node:assert/strict";
import test from "node:test";

import type { DynamicsSession } from "../dynamics/session.js";
import { readWorldRuntimeClockAuthority } from "./clockAuthority.js";
import type { WorldActIngressRejectionReason } from "./actTypes.js";
import { runtimeActionJournalSnapshot, runtimeActEnvelope, runtimeFixtureWithHooks, type RuntimeFixtureHooks } from "./runtime.test-helper.js";

const denied = (reason: WorldActIngressRejectionReason) => Object.freeze({
  disposition: "rejected_at_ingress" as const,
  code: "world_action_denied" as const,
  reason,
});

const redAction = Object.freeze({
  affordance: "world://pitch/affordance/kick",
  target: "world://pitch/entity/ball",
  input: { force: 1 },
});
const blueAction = Object.freeze({
  affordance: "world://pitch/affordance/wait",
  target: "world://pitch/entity/blue",
  input: { force: 1 },
});
const commands = (input: unknown): readonly { readonly sequence: number }[] =>
  (input as { readonly actions: readonly { readonly sequence: number }[] }).actions;
const realAcceptedStep = (input: unknown) => ({
  tick: (input as { readonly tick: number }).tick,
  events: [],
  action_results: commands(input).map(({ sequence }) => ({ accepted: true, sequence })),
});
const queueRed = (fixture: ReturnType<typeof runtimeFixtureWithHooks>) => {
  const receipt = fixture.runtime!.act({ principal: "principal-red", decisionToken: fixture.red.token }, runtimeActEnvelope("red-action", redAction));
  assert.equal(receipt.disposition, "queued");
  return receipt;
};
const queuedMutation = (dynamics: DynamicsSession) => dynamics.queueAction({
  act_id: "projection-mutation", action: "wait", actor: "object:blue", at_tick: dynamics.nextTick,
  input: {}, origin: "agentic", principal_id: "principal-blue", target: "object:blue",
});

test("real checked projections honestly record absent, throw, thenable, and malformed callbacks", () => {
  const cases: readonly [string, RuntimeFixtureHooks["projectResult"], "not_configured" | "failed", number][] = [
    ["absent", null, "not_configured", 0],
    ["throw", () => { throw new Error("projection throw"); }, "failed", 1],
    ["thenable", () => ({ then: () => {} }), "failed", 1],
    ["malformed", () => [] as unknown as Record<string, never>, "failed", 1],
  ];
  for (const [name, callback, expected, callbacks] of cases) {
    let calls = 0;
    const fixture = runtimeFixtureWithHooks({
      step: realAcceptedStep,
      projectResult: callback === null ? null : (input, dynamics) => { calls += 1; return callback!(input, dynamics); },
    });
    const receipt = queueRed(fixture);
    assert.equal(readWorldRuntimeClockAuthority(fixture.runtime!)!.stepDynamics().tick, 0, name);
    assert.equal(calls, callbacks, name);
    assert.equal(fixture.dynamics.nextTick, 1, name);
    assert.equal(fixture.dynamics.snapshot().pending_actions.length, 0, name);
    const terminal = runtimeActionJournalSnapshot(fixture.runtime!)!.cells[0]!.terminal!;
    assert.equal(terminal.receipt_id, receipt.receipt_id, name);
    assert.equal(terminal.disposition, "applied", name);
    assert.equal(terminal.projection, expected, name);
    assert.equal(runtimeActionJournalSnapshot(fixture.runtime!)!.closed, false, name);
  }
});

test("reserved real projection output records the applied fact as failed without closing mechanics", () => {
  let calls = 0;
  const fixture = runtimeFixtureWithHooks({
    step: realAcceptedStep,
    projectResult: () => { calls += 1; return { receipt: "invented" }; },
  });
  const receipt = queueRed(fixture);
  readWorldRuntimeClockAuthority(fixture.runtime!)!.stepDynamics();
  assert.equal(calls, 1);
  assert.equal(fixture.dynamics.nextTick, 1);
  assert.equal(fixture.dynamics.snapshot().pending_actions.length, 0);
  const snapshot = runtimeActionJournalSnapshot(fixture.runtime!)!;
  assert.equal(snapshot.closed, false);
  assert.deepEqual(snapshot.cells.map((cell) => [cell.receipt.receipt_id, cell.terminal?.disposition, cell.terminal?.projection]), [
    [receipt.receipt_id, "applied", "failed"],
  ]);
});

test("caught and uncaught actual runtime reentry fail only the already-applied projection", () => {
  for (const uncaught of [false, true]) {
    let calls = 0;
    let nested: unknown;
    let fixture: ReturnType<typeof runtimeFixtureWithHooks>;
    fixture = runtimeFixtureWithHooks({
      step: realAcceptedStep,
      projectResult: () => {
        calls += 1;
        nested = fixture.runtime!.act({ principal: "principal-blue", decisionToken: fixture.blue.token }, runtimeActEnvelope("blue-reentry", blueAction));
        if (uncaught) throw new Error("projection reentry escape");
        return { callback: "returned" };
      },
    });
    queueRed(fixture);
    readWorldRuntimeClockAuthority(fixture.runtime!)!.stepDynamics();
    assert.equal(calls, 1);
    assert.deepEqual(nested, denied("ingress_reentered"));
    assert.equal(runtimeActionJournalSnapshot(fixture.runtime!)!.cells[0]!.terminal?.projection, "failed");
    assert.equal(fixture.dynamics.nextTick, 1);
    assert.equal(fixture.dynamics.snapshot().pending_actions.length, 0);
    assert.equal(fixture.runtime!.act({ principal: "principal-blue", decisionToken: fixture.blue.token }, runtimeActEnvelope("blue-after-reentry", blueAction)).disposition, "queued");
  }
});

test("real dynamics queue and tick mutations are restored after projection without erasing mechanics", () => {
  for (const mutation of [
    (dynamics: DynamicsSession) => queuedMutation(dynamics),
    (dynamics: DynamicsSession) => dynamics.step(),
  ]) {
    let calls = 0;
    const fixture = runtimeFixtureWithHooks({
      step: realAcceptedStep,
      projectResult: (_input, dynamics) => { calls += 1; mutation(dynamics); return { mutation: true }; },
    });
    const receipt = queueRed(fixture);
    readWorldRuntimeClockAuthority(fixture.runtime!)!.stepDynamics();
    assert.equal(calls, 1);
    assert.equal(fixture.dynamics.nextTick, 1);
    assert.equal(fixture.dynamics.snapshot().pending_actions.length, 0);
    const terminal = runtimeActionJournalSnapshot(fixture.runtime!)!.cells[0]!.terminal!;
    assert.equal(terminal.receipt_id, receipt.receipt_id);
    assert.equal(terminal.disposition, "applied");
    assert.equal(terminal.projection, "failed");
  }
});

test("a real provider restore failure closes future clock and act operations after the applied fact", () => {
  let callbacks = 0;
  let failRestore = true;
  const fixture = runtimeFixtureWithHooks({
    step: realAcceptedStep,
    projectResult: () => { callbacks += 1; throw new Error("projection failure"); },
    failRestore: () => {
      if (!failRestore) return false;
      failRestore = false;
      return true;
    },
  });
  const receipt = queueRed(fixture);
  const clock = readWorldRuntimeClockAuthority(fixture.runtime!)!;
  assert.throws(() => clock.stepDynamics(), /restore failed/u);
  assert.equal(callbacks, 1);
  assert.equal(fixture.restoreCalls(), 2);
  assert.equal(fixture.dynamics.nextTick, 1);
  assert.equal(fixture.dynamics.snapshot().pending_actions.length, 0);
  const snapshot = runtimeActionJournalSnapshot(fixture.runtime!)!;
  assert.equal(snapshot.closed, true);
  assert.deepEqual(snapshot.cells.map((cell) => [cell.receipt.receipt_id, cell.terminal?.disposition, cell.terminal?.projection]), [
    [receipt.receipt_id, "applied", "not_configured"],
  ]);
  assert.deepEqual(fixture.runtime!.act({ principal: "principal-blue", decisionToken: fixture.blue.token }, runtimeActEnvelope("blue-after-close", blueAction)), denied("ingress_closed"));
  assert.throws(() => clock.stepDynamics(), /mechanics closed/u);
});

test("multi-action real projection is ordered and fatal restore failure prevents later callbacks or partial projection success", () => {
  let callbacks = 0;
  let beforeFirstProjection: unknown;
  let failRestore = true;
  let fixture: ReturnType<typeof runtimeFixtureWithHooks>;
  fixture = runtimeFixtureWithHooks({
    step: realAcceptedStep,
    projectResult: () => {
      callbacks += 1;
      beforeFirstProjection ??= runtimeActionJournalSnapshot(fixture.runtime!)!.cells.map((cell) => [cell.sequence, cell.terminal?.disposition, cell.terminal?.projection]);
      throw new Error("first projection fails");
    },
    failRestore: () => {
      if (!failRestore) return false;
      failRestore = false;
      return true;
    },
  });
  const red = queueRed(fixture);
  const blue = fixture.runtime!.act({ principal: "principal-blue", decisionToken: fixture.blue.token }, runtimeActEnvelope("blue-action", blueAction));
  assert.equal(blue.disposition, "queued");
  assert.throws(() => readWorldRuntimeClockAuthority(fixture.runtime!)!.stepDynamics(), /restore failed/u);
  assert.equal(callbacks, 1);
  assert.deepEqual(beforeFirstProjection, [[1, "applied", "not_configured"], [2, "applied", "not_configured"]]);
  const snapshot = runtimeActionJournalSnapshot(fixture.runtime!)!;
  assert.equal(snapshot.closed, true);
  assert.deepEqual(snapshot.cells.map((cell) => [cell.receipt.receipt_id, cell.record.mechanics_action, cell.terminal?.projection]), [
    [red.receipt_id, "kick", "not_configured"], [blue.receipt_id, "wait", "not_configured"],
  ]);
});
