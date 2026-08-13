import assert from "node:assert/strict";
import test from "node:test";

import { readCheckedDynamicsSession } from "../dynamics/session.js";
import { readParsedWorldSurfaceRegistry } from "../world-surface/definition.js";
import { readWorldActionResultLedger } from "./actionResultLedger.js";
import { readWorldRuntimeClockAuthority } from "./clockAuthority.js";
import { runtimeActionJournalSnapshot, runtimeActionJournalStatus, runtimeActionResultLedger, runtimeActEnvelope, runtimeFixtureWithHooks, runtimeRequestLedgerSnapshot } from "./runtime.test-helper.js";

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
const accepted = (input: unknown) => commands(input).map(({ sequence }) => ({ accepted: true, sequence }));
const event = (causes: number[]) => ({
  cause_action_sequences: causes, kind: "impact", payload: { strength: 1 }, source: "system:test", target: "object:ball",
});
const queueRed = (fixture: ReturnType<typeof runtimeFixtureWithHooks>) => {
  const receipt = fixture.runtime!.act({ principal: "principal-red", decisionToken: fixture.red.token }, runtimeActEnvelope("red-action", redAction));
  assert.equal(receipt.disposition, "queued");
  return receipt;
};

// Foreign, duplicate, and identity-corrupt post-step joins remain unreachable through this
// checked session; actionResults.test.ts retains those direct resolver proofs. The matrix below
// exercises the reachable checked-session result-mode boundary before post-step joining.
test("a real checked provider commits accepted and declared rejected mechanics durably", () => {
  let projections = 0;
  const appliedFixture = runtimeFixtureWithHooks({
    step: (input) => ({ tick: 0, events: [], action_results: accepted(input) }),
    projectResult: () => { projections += 1; return { outcome: true }; },
  });
  assert.ok(readCheckedDynamicsSession(appliedFixture.dynamics));
  assert.ok(readParsedWorldSurfaceRegistry(appliedFixture.surfaceRegistry));
  const appliedReceipt = queueRed(appliedFixture);
  const appliedClock = readWorldRuntimeClockAuthority(appliedFixture.runtime!);
  assert.ok(appliedClock);
  assert.deepEqual(appliedClock.stepDynamics(), { tick: 0, action_results: 1, events: 0 });
  assert.equal(appliedFixture.dynamics.nextTick, 1);
  assert.equal(appliedFixture.dynamics.snapshot().pending_actions.length, 0);
  assert.equal(projections, 1);
  const applied = runtimeActionJournalSnapshot(appliedFixture.runtime!)!;
  assert.deepEqual(applied.cells.map((cell) => [cell.receipt.receipt_id, cell.terminal?.disposition, cell.terminal?.projection]), [
    [appliedReceipt.receipt_id, "applied", "projected"],
  ]);

  let rejectedProjections = 0;
  const rejectedFixture = runtimeFixtureWithHooks({
    step: (input) => ({ tick: 0, events: [], action_results: commands(input).map(({ sequence }) => ({ accepted: false, code: "blocked", sequence })) }),
    projectResult: () => { rejectedProjections += 1; return { unexpected: true }; },
  });
  const rejectedReceipt = queueRed(rejectedFixture);
  readWorldRuntimeClockAuthority(rejectedFixture.runtime!)!.stepDynamics();
  assert.equal(rejectedFixture.dynamics.nextTick, 1);
  assert.equal(rejectedFixture.dynamics.snapshot().pending_actions.length, 0);
  assert.equal(rejectedProjections, 0);
  assert.deepEqual(runtimeActionJournalSnapshot(rejectedFixture.runtime!)!.cells[0]!.terminal, {
    disposition: "rejected_at_mechanics", receipt_id: rejectedReceipt.receipt_id,
    decision_id: rejectedReceipt.decision_id, sequence: 1, apply_tick: 0,
    projection: "not_configured", public_code: "blocked",
  });
});

const checkedRejectionMustClose = (name: string, result: Readonly<Record<string, unknown>>) => {
  const fixture = runtimeFixtureWithHooks({ step: (input) => ({
    tick: 0, events: [], action_results: commands(input).map(({ sequence }) => ({ ...result, sequence })),
  }) });
  const receipt = queueRed(fixture);
  const clock = readWorldRuntimeClockAuthority(fixture.runtime!)!;
  assert.throws(() => clock.stepDynamics(), name);
  assert.equal(fixture.dynamics.nextTick, 0);
  assert.equal(fixture.dynamics.snapshot().pending_actions.length, 1);
  const pending = runtimeActionJournalSnapshot(fixture.runtime!)!;
  assert.equal(pending.closed, true);
  assert.deepEqual(pending.cells.map((cell) => [cell.receipt.receipt_id, cell.state, cell.terminal]), [[receipt.receipt_id, "authorized", null]]);
  assert.equal(runtimeActionJournalStatus(fixture.runtime!)!.closed, true);
  assert.equal(runtimeRequestLedgerSnapshot(fixture.runtime!)!.closed, true);
  assert.deepEqual(runtimeActionResultLedger(fixture.runtime!)!.read("principal-red", { version: "simfile.world-action-result-page-request.v1" }).results, []);
  assert.throws(() => clock.stepDynamics(), /closed/u);
};

test("real checked provider retains undeclared rejection truth while exposing the fixed public code", () => {
  const fixture = runtimeFixtureWithHooks({
    step: (input) => ({
      tick: 0,
      events: [],
      action_results: commands(input).map(({ sequence }) => ({ accepted: false, code: "private_code", sequence })),
    }),
  });
  const receipt = queueRed(fixture);
  const clock = readWorldRuntimeClockAuthority(fixture.runtime!)!;
  assert.deepEqual(clock.stepDynamics(), { tick: 0, action_results: 1, events: 0 });
  assert.equal(fixture.dynamics.nextTick, 1);
  assert.equal(fixture.dynamics.snapshot().pending_actions.length, 0);
  assert.deepEqual(runtimeActionJournalSnapshot(fixture.runtime!)!.cells.map((cell) => cell.terminal), [{
    disposition: "rejected_at_mechanics",
    receipt_id: receipt.receipt_id,
    decision_id: receipt.decision_id,
    sequence: 1,
    apply_tick: 0,
    projection: "not_configured",
    public_code: "world_action_rejected",
  }]);
});

test("checked session closes on provider rejections missing a code without fabricating a terminal", () => {
  checkedRejectionMustClose("missing", { accepted: false });
});

const bindResultLedger = (fixture: ReturnType<typeof runtimeFixtureWithHooks>) => {
  const ledger = runtimeActionResultLedger(fixture.runtime);
  assert.ok(ledger);
  return ledger;
};

test("real result-mode checked validation rejects invalid provider and causality outputs atomically", () => {
  const cases = [
    ["foreign", false, (actions: readonly { readonly sequence: number }[]) => [{ accepted: true, sequence: actions[0]!.sequence + 1 }]],
    ["duplicate", true, (actions: readonly { readonly sequence: number }[]) => actions.map(() => ({ accepted: true, sequence: 1 }))],
    ["missing", false, () => []],
    ["identity-corrupt", false, (actions: readonly { readonly sequence: number }[]) => [{ accepted: true, sequence: actions[0]!.sequence, identity: { actor: "foreign" } }]],
    ["missing rejection code", false, (actions: readonly { readonly sequence: number }[]) => [{ accepted: false, sequence: actions[0]!.sequence }]],
    ["rejected", false, (actions: readonly { readonly sequence: number }[]) => [{ accepted: false, code: "blocked", sequence: actions[0]!.sequence }]],
    ["unknown", false, (actions: readonly { readonly sequence: number }[]) => [{ accepted: true, sequence: actions[0]!.sequence }]],
  ] as const;
  for (const [name, twoActions, output] of cases) {
    const fixture = runtimeFixtureWithHooks({ step: (input) => {
      const actions = commands(input);
      const actionResults = output(actions);
      return { tick: 0, action_results: actionResults, events: name === "rejected" ? [event([actions[0]!.sequence])] : name === "unknown" ? [event([99])] : [] };
    } });
    const ledger = bindResultLedger(fixture);
    queueRed(fixture);
    if (twoActions) {
      const receipt = fixture.runtime!.act({ principal: "principal-blue", decisionToken: fixture.blue.token }, runtimeActEnvelope(`${name}-blue`, blueAction));
      assert.equal(receipt.disposition, "queued");
    }
    const authority = readWorldActionResultLedger(ledger)!;
    const clock = readWorldRuntimeClockAuthority(fixture.runtime!)!;
    assert.throws(() => clock.stepDynamics());
    assert.equal(fixture.dynamics.nextTick, 0);
    assert.equal(fixture.dynamics.snapshot().pending_actions.length, twoActions ? 2 : 1);
    assert.equal(authority.hasLiveReservation(), false);
    assert.deepEqual(ledger.read("principal-red", { version: "simfile.world-action-result-page-request.v1" }).results, []);
    assert.deepEqual(ledger.read("principal-blue", { version: "simfile.world-action-result-page-request.v1" }).results, []);
    const journal = runtimeActionJournalSnapshot(fixture.runtime!)!;
    assert.equal(journal.closed, true);
    assert.deepEqual(journal.cells.map((cell) => [cell.state, cell.terminal]), journal.cells.map(() => ["authorized", null]));
    assert.equal(runtimeActionJournalStatus(fixture.runtime!)!.closed, true);
    assert.equal(runtimeRequestLedgerSnapshot(fixture.runtime!)!.closed, true);
    assert.equal(fixture.dynamics.nextTick, 0);
    assert.throws(() => clock.stepDynamics(), /closed/u);
    assert.equal(authority.hasLiveReservation(), false);
  }
});

test("provider throw rolls back a real step and later resolves its retained action exactly once", () => {
  let throws = true;
  let steps = 0;
  let projections = 0;
  const fixture = runtimeFixtureWithHooks({
    step: (input) => {
      steps += 1;
      if (throws) { throws = false; throw new Error("provider step failure"); }
      return { tick: 0, events: [event([commands(input)[0]!.sequence])], action_results: accepted(input) };
    },
    projectResult: () => { projections += 1; return { recovered: true }; },
  });
  const ledger = bindResultLedger(fixture);
  const receipt = queueRed(fixture);
  const clock = readWorldRuntimeClockAuthority(fixture.runtime!)!;
  assert.throws(() => clock.stepDynamics(), /checked step failed/u);
  assert.equal(fixture.dynamics.nextTick, 0);
  assert.equal(fixture.dynamics.snapshot().pending_actions.length, 1);
  assert.deepEqual(runtimeActionJournalSnapshot(fixture.runtime!)!.cells.map((cell) => [cell.receipt.receipt_id, cell.state, cell.terminal]), [[receipt.receipt_id, "authorized", null]]);
  assert.equal(readWorldActionResultLedger(ledger)!.hasLiveReservation(), false);
  assert.equal(clock.stepDynamics().tick, 0);
  assert.equal(steps, 2);
  assert.equal(projections, 1);
  assert.equal(fixture.dynamics.snapshot().pending_actions.length, 0);
  const page = ledger.read("principal-red", { version: "simfile.world-action-result-page-request.v1" });
  assert.deepEqual(page.results.map((result) => result.result_id), ["world-result-1"]);
  assert.deepEqual((page.results[0]! as Extract<typeof page.results[number], { status: "applied" }>).caused_effect_ids, ["world-effect-1"]);
  assert.deepEqual(runtimeActionJournalSnapshot(fixture.runtime!)!.cells.map((cell) => cell.terminal?.disposition), ["applied"]);
});

test("real provider event causality accepts current, prior, and uncaused events and rejects rejected or unknown causes", () => {
  const current = runtimeFixtureWithHooks({
    step: (input) => ({ tick: 0, action_results: accepted(input), events: [event([commands(input)[0]!.sequence])] }),
  });
  queueRed(current);
  assert.equal(readWorldRuntimeClockAuthority(current.runtime!)!.stepDynamics().events, 1);

  let priorStep = 0;
  const prior = runtimeFixtureWithHooks({ step: (input) => {
    priorStep += 1;
    return { tick: priorStep - 1, action_results: accepted(input), events: [event(priorStep === 1 ? [commands(input)[0]!.sequence] : [1])] };
  } });
  queueRed(prior);
  const priorClock = readWorldRuntimeClockAuthority(prior.runtime!)!;
  priorClock.stepDynamics();
    assert.equal(prior.runtime!.act({ principal: "principal-blue", decisionToken: prior.blue.token }, runtimeActEnvelope("blue-action", blueAction)).disposition, "queued");
  assert.equal(priorClock.stepDynamics().events, 1);

  const uncaused = runtimeFixtureWithHooks({ step: (input) => ({ tick: 0, action_results: accepted(input), events: [event([])] }) });
  queueRed(uncaused);
  assert.equal(readWorldRuntimeClockAuthority(uncaused.runtime!)!.stepDynamics().events, 1);

  for (const [name, actionResults, causes] of [
    ["rejected", [{ accepted: false, code: "blocked", sequence: 1 }], [1]],
    ["unknown", [{ accepted: true, sequence: 1 }], [99]],
  ] as const) {
    const fixture = runtimeFixtureWithHooks({ step: () => ({ tick: 0, action_results: actionResults, events: [event([...causes])] }) });
    queueRed(fixture);
    assert.throws(() => readWorldRuntimeClockAuthority(fixture.runtime!)!.stepDynamics(), name);
    assert.equal(fixture.dynamics.nextTick, 0);
    assert.equal(fixture.dynamics.snapshot().pending_actions.length, 1);
    assert.equal(runtimeActionJournalSnapshot(fixture.runtime!)!.cells[0]!.terminal, null);
  }
});

test("the result-mode integration uses the same checked session for causal publication", () => {
  const fixture = runtimeFixtureWithHooks({ step: (input) => ({ tick: 0, action_results: accepted(input), events: [event([commands(input)[0]!.sequence])] }) });
  const ledger = runtimeActionResultLedger(fixture.runtime);
  assert.ok(ledger);
  queueRed(fixture);
  assert.equal(readWorldRuntimeClockAuthority(fixture.runtime!)!.stepDynamics().events, 1);
  const page = ledger.read("principal-red", { version: "simfile.world-action-result-page-request.v1" });
  assert.equal(page.results.length, 1); assert.equal(page.results[0]!.status, "applied");
  assert.deepEqual((page.results[0]! as Extract<typeof page.results[number], { status: "applied" }>).caused_effect_ids, ["world-effect-1"]);
  assert.equal(fixture.dynamics.nextTick, 1);
});
