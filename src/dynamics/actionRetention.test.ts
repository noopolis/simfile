import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadDynamicsSession } from "./load.js";
import { DYNAMICS_ACTION_RETENTION_LIMITS } from "./limits.js";
import {
  counterAction,
  createDynamicsTestProject,
  removeDynamicsTestProject
} from "./testSupport.test-helper.js";

describe("DynamicsSession retained action invariants", () => {
  it("keeps a prior-tick identity window without emitting replay evidence", async () => {
    const project = await createDynamicsTestProject();
    try {
      const session = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath });
      assert.ok(session);
      const first = counterAction({ act_id: "cross-tick", input: { amount: 1 } });
      assert.deepEqual(session.queueAction(first), { act_id: "cross-tick", apply_tick: 0, queued: true, sequence: 1 });
      session.step();
      const afterStep = session.snapshot();
      assert.equal(afterStep.action_ingress.length, 1);
      assert.equal(afterStep.action_ingress[0]?.retained_at_tick, 0);
      assert.equal(afterStep.action_ingress[0]?.receipt.code, "wrong_tick");
      assert.deepEqual(session.queueAction({ ...first, at_tick: 1, input: { amount: 2 } }), {
        act_id: "cross-tick", apply_tick: 1, code: "act_id_conflict", queued: false
      });
      assert.deepEqual(session.snapshot(), afterStep);
      assert.deepEqual(session.readActionIngressEvidence(1), []);
    } finally { await removeDynamicsTestProject(project); }
  });

  it("evicts the canonical oldest identity when the bounded window is exceeded", async () => {
    const project = await createDynamicsTestProject();
    try {
      const session = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath });
      assert.ok(session);
      for (let index = 0; index < DYNAMICS_ACTION_RETENTION_LIMITS.records + 1; index += 1) {
        session.queueAction(counterAction({ act_id: `window-${index}` }));
        session.step();
      }
      assert.equal(session.snapshot().action_ingress.length, DYNAMICS_ACTION_RETENTION_LIMITS.records);
      assert.equal(session.queueAction(counterAction({ act_id: "window-0", at_tick: session.nextTick })).queued, true);
    } finally { await removeDynamicsTestProject(project); }
  });

  it("round-trips a populated cross-tick window byte-for-byte", async () => {
    const project = await createDynamicsTestProject();
    try {
      const session = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath });
      assert.ok(session);
      session.queueAction(counterAction({ act_id: "round-trip" }));
      session.step();
      const snapshot = session.snapshot();
      session.restore(snapshot);
      assert.deepEqual(session.snapshot(), snapshot);
    } finally { await removeDynamicsTestProject(project); }
  });

  it("detects a digest conflict for a deep nested input-only change", async () => {
    const project = await createDynamicsTestProject();
    try {
      const session = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath });
      assert.ok(session);
      session.queueAction(counterAction({
        input: { nested: { entries: [{ value: "first" }] } }
      }));
      assert.deepEqual(session.queueAction(counterAction({
        input: { nested: { entries: [{ value: "second" }] } }
      })), {
        act_id: "act-1",
        apply_tick: 0,
        code: "act_id_conflict",
        queued: false
      });
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("rejects inconsistent watermarks and retained receipt times", async () => {
    const project = await createDynamicsTestProject();
    try {
      const session = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath });
      assert.ok(session);
      session.queueAction(counterAction());
      session.step();
      const resolved = session.snapshot();
      const futureResolved = structuredClone(resolved);
      futureResolved.resolved_action_sequences.floor += 1;
      assert.throws(() => session.restore(futureResolved), /resolved sequence watermark/u);

      const fresh = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath });
      assert.ok(fresh);
      fresh.queueAction(counterAction({ act_id: "future", at_tick: 2 }));
      const rejected = fresh.snapshot();
      const rejectedRecord = rejected.action_ingress[0];
      if (rejectedRecord) rejectedRecord.receipt.apply_tick = 1;
      assert.throws(() => fresh.restore(rejected), /belong to next_tick/u);
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("requires retained queued sequences to be contiguous from the persisted floor", async () => {
    const project = await createDynamicsTestProject();
    try {
      const session = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath });
      assert.ok(session);
      session.queueAction(counterAction({ act_id: "z-first" }));
      session.step();
      session.queueAction(counterAction({ act_id: "a-second", at_tick: 1 }));
      const snapshot = session.snapshot();
      assert.deepEqual(
        snapshot.action_ingress.filter((record) => record.receipt.queued)
          .map((record) => [record.receipt.sequence, record.at_tick]),
        [[2, 1]]
      );

      const inverted = structuredClone(snapshot);
      inverted.action_ingress_floor = 1;
      assert.throws(
        () => session.restore(inverted),
        /contiguous from the retained floor/u
      );
      assert.doesNotThrow(() => session.restore(snapshot));
    } finally {
      await removeDynamicsTestProject(project);
    }
  });
});
