import assert from "node:assert/strict";
import test from "node:test";

import { readCheckedDynamicsSession } from "../dynamics/session.js";
import { readParsedWorldSurfaceRegistry } from "../world-surface/definition.js";
import { runtimeActionJournalSnapshot, runtimeActEnvelope, runtimeFixtureWithHooks } from "./runtime.test-helper.js";
import { readWorldRuntimeActionJournalInspection } from "./actionJournalInspection.js";
import { readWorldRuntimeClockAuthority } from "./clockAuthority.js";

const action = {
  affordance: "world://pitch/affordance/kick",
  target: "world://pitch/entity/ball",
  input: { force: 1 },
};

test("real runtime actions are inspectable across queue and accepted step", () => {
  const fixture = runtimeFixtureWithHooks({
    step: (input) => {
      const queued = (input as { actions: readonly { sequence: number }[] }).actions[0]!;
      return { tick: 0, events: [], action_results: [{ accepted: true, sequence: queued.sequence }] };
    },
  });
  const runtime = fixture.runtime!;

  assert.ok(readCheckedDynamicsSession(fixture.dynamics));
  assert.ok(readParsedWorldSurfaceRegistry(fixture.surfaceRegistry));
  const clock = readWorldRuntimeClockAuthority(runtime);
  assert.ok(clock);
  const receipt = runtime.act(
    { principal: "principal-red", decisionToken: fixture.red.token }, runtimeActEnvelope("real-action", action),
  );
  if (receipt.disposition !== "queued") throw new Error("expected queued receipt");
  assert.equal(fixture.dynamics.snapshot().pending_actions.length, 1);

  const queued = runtimeActionJournalSnapshot(runtime)!;
  assert.equal(queued.cells.length, 1);
  assert.equal(queued.cells[0]!.state, "authorized");
  assert.equal(queued.cells[0]!.terminal, null);
  assert.equal(queued.cells[0]!.receipt.receipt_id, receipt.receipt_id);

  const step = clock.stepDynamics();
  assert.deepEqual(step, { tick: 0, action_results: 1, events: 0 });
  assert.equal(fixture.dynamics.nextTick, 1);
  const applied = runtimeActionJournalSnapshot(runtime)!;
  assert.equal(applied.cells[0]!.receipt.receipt_id, receipt.receipt_id);
  const terminal = applied.cells[0]!.terminal!;
  assert.equal(terminal.disposition, "applied");
  assert.equal(terminal.receipt_id, receipt.receipt_id);
  assert.equal(terminal.sequence, 1);
  assert.equal(terminal.apply_tick, 0);
  assert.equal(terminal.projection, "projected");
  assert.equal(terminal.effect?.outcome, true);
});

test("inspection is exact-runtime, immutable, and read-only", () => {
  const fixture = runtimeFixtureWithHooks({
    step: (input) => {
      const queued = (input as { actions: readonly { sequence: number }[] }).actions[0]!;
      return { tick: 0, events: [], action_results: [{ accepted: true, sequence: queued.sequence }] };
    },
  });
  const runtime = fixture.runtime!;
  const inspection = readWorldRuntimeActionJournalInspection(runtime);
  assert.ok(inspection);
  assert.equal(readWorldRuntimeActionJournalInspection({ ...runtime }), undefined);
  assert.equal(readWorldRuntimeActionJournalInspection({}), undefined);
  assert.equal(readWorldRuntimeActionJournalInspection(null), undefined);
  assert.deepEqual(Object.keys(inspection), ["snapshot", "status"]);
  assert.equal("reserve" in inspection, false);
  assert.equal("audit" in inspection, false);
  assert.deepEqual(inspection.status(), { closed: false, audit_count: 0, cell_count: 0 });

  const receipt = runtime.act(
    { principal: "principal-red", decisionToken: fixture.red.token }, runtimeActEnvelope("inspection-action", action),
  );
  if (receipt.disposition !== "queued") throw new Error("expected queued receipt");
  const snapshot = inspection.snapshot();
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.cells));
  assert.ok(Object.isFrozen(snapshot.cells[0]));
  assert.ok(Object.isFrozen(snapshot.cells[0]!.receipt));
  assert.equal(snapshot.cells[0]!.receipt.receipt_id, receipt.receipt_id);
  assert.throws(() => (snapshot.cells as unknown as unknown[]).pop(), TypeError);
  const sourceIsolated = inspection.snapshot();
  assert.deepEqual(sourceIsolated, snapshot);
});
