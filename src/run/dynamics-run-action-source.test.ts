import assert from "node:assert/strict";
import test from "node:test";

import {
  DYNAMICS_RUN_ACTION_SOURCE_VERSION,
  type DynamicsRunActionSourceDeclaration,
  type DynamicsRunControllerAction
} from "../dynamics/runActionSource.js";
import type { DynamicsSession } from "../dynamics/session.js";
import type {
  DynamicsActionAttempt,
  DynamicsActionIngressRecord,
  DynamicsStepResult
} from "../dynamics/types.js";
import {
  createWorldRuntimeControllerAuthority,
  isWorldRuntimeControllerAuthority,
  type WorldRuntimeControllerAuthority
} from "../world/controllerAuthority.js";
import { createDynamicsRunActionSourceHost } from "./dynamics-run-action-source.js";

interface SessionProbe {
  readonly attempts: DynamicsActionAttempt[];
  readonly session: DynamicsSession;
  step(): DynamicsStepResult;
}

const createSessionProbe = (): SessionProbe => {
  let nextTick = 0;
  let nextSequence = 1;
  let pending: Array<DynamicsActionAttempt & { sequence: number }> = [];
  const attempts: DynamicsActionAttempt[] = [];
  const session = {
    get nextTick() {
      return nextTick;
    },
    queueAction(value: unknown) {
      const attempt = structuredClone(value) as DynamicsActionAttempt;
      const sequence = nextSequence++;
      attempts.push(attempt);
      pending.push({ ...attempt, sequence });
      return {
        act_id: attempt.act_id,
        apply_tick: nextTick,
        queued: true,
        sequence
      };
    }
  } as unknown as DynamicsSession;
  return {
    attempts,
    session,
    step: (): DynamicsStepResult => {
      const tick = nextTick++;
      const action_results = pending.map((attempt) => ({
        accepted: true,
        act_id: attempt.act_id,
        action: attempt.action,
        actor: attempt.actor,
        apply_tick: tick,
        origin: attempt.origin,
        principal_id: attempt.principal_id,
        sequence: attempt.sequence,
        target: attempt.target
      }));
      pending = [];
      return { action_results, events: [], tick };
    }
  };
};

const action = (index: number): DynamicsRunControllerAction => ({
  action: `move:${index}`,
  actor: `actor:${index}`,
  controller_id: `controller-${index}`,
  controller_version: "test-v1",
  input: { index },
  policy: "default",
  skill: "move",
  target: `target:${index}`
});

const source = (
  onTick: DynamicsRunActionSourceDeclaration["onTick"]
): DynamicsRunActionSourceDeclaration => ({
  id: "host-test",
  live_acceptance: false,
  onTick,
  participants: ["blue", "red"],
  provenance: "scripted",
  version: DYNAMICS_RUN_ACTION_SOURCE_VERSION
});

test("zero, one, and many submissions use the controller authority in source order", () => {
  for (const count of [0, 1, 3]) {
    const probe = createSessionProbe();
    const host = createDynamicsRunActionSourceHost({
      session: probe.session,
      source: source((context) => {
        assert.deepEqual(
          Reflect.ownKeys(context).sort(),
          ["act", "next_tick", "observe", "queueController", "sim_time"]
        );
        for (let index = 0; index < count; index += 1) {
          context.queueController(action(index));
        }
      })
    });
    host.notify(0);
    const step = probe.step();
    host.settle(step);
    assert.deepEqual(
      probe.attempts.map((attempt) => attempt.action),
      Array.from({ length: count }, (_, index) => `move:${index}`)
    );
    assert.deepEqual(
      probe.attempts.map((attempt) => attempt.origin),
      Array.from({ length: count }, () => "controller")
    );
  }
});

test("a hanging returned promise is ignored and does not gate settlement", () => {
  const probe = createSessionProbe();
  const never = new Promise<void>(() => {});
  const host = createDynamicsRunActionSourceHost({
    session: probe.session,
    source: source(() => never)
  });
  host.notify(0);
  const step = probe.step();
  host.settle(step);
  assert.equal(probe.session.nextTick, 1);
  assert.deepEqual(probe.attempts, []);
});

test("a late async submission sees the closed tick and never enters ingress", async () => {
  const probe = createSessionProbe();
  let late: Promise<void> | undefined;
  const host = createDynamicsRunActionSourceHost({
    session: probe.session,
    source: source((context) => {
      late = (async () => {
        await undefined;
        assert.throws(
          () => context.queueController(action(0)),
          /action source tick is closed/u
        );
      })();
      return late;
    })
  });
  host.notify(0);
  await late;
  assert.deepEqual(probe.attempts, []);
});

test("a synchronous source failure is surfaced once without retry", () => {
  const probe = createSessionProbe();
  let calls = 0;
  const host = createDynamicsRunActionSourceHost({
    session: probe.session,
    source: source(() => {
      calls += 1;
      throw new Error(`injected source failure call ${calls}`);
    })
  });
  assert.throws(
    () => host.notify(0),
    /injected source failure call 1/u
  );
  assert.equal(calls, 1);
});

test("observation is declaration-scoped and unavailable without the B161 port", () => {
  const probe = createSessionProbe();
  const host = createDynamicsRunActionSourceHost({
    session: probe.session,
    source: source((context) => {
      assert.throws(
        () => context.observe("other", {}),
        /participant other is not declared/u
      );
      assert.throws(
        () => context.observe("blue", {}),
        /participant observation is unavailable/u
      );
    })
  });
  host.notify(0);
});

test("participant hosts reject forged controllers while accepting read-only and issued hosts", () => {
  const forgedProbe = createSessionProbe();
  const forged: WorldRuntimeControllerAuthority = Object.freeze({
    inspect: () => Object.freeze([]),
    queue: () => Object.freeze({
      act_id: "forged",
      apply_tick: 0,
      queued: false
    }),
    settle: (step: DynamicsStepResult) => step
  });
  const forgedParticipantHost = Object.freeze({ controller: forged });
  assert.equal(isWorldRuntimeControllerAuthority(forged), false);
  assert.equal(
    forgedParticipantHost !== undefined
      && !isWorldRuntimeControllerAuthority(forgedParticipantHost.controller),
    true
  );
  assert.throws(
    () => createDynamicsRunActionSourceHost({
      participantHost: forgedParticipantHost,
      session: forgedProbe.session,
      source: source(() => {})
    }),
    /^Error: invalid dynamics run participant controller authority$/u
  );

  const readOnlyProbe = createSessionProbe();
  let observed = 0;
  const readOnlyHost = createDynamicsRunActionSourceHost({
    participantHost: {
      read: {
        observe: (participant, request) => {
          observed += 1;
          assert.equal(participant, "blue");
          assert.deepEqual(request, { sense: "open" });
          return "observation";
        }
      }
    },
    session: readOnlyProbe.session,
    source: source((context) => {
      assert.equal(
        context.observe("blue", { sense: "open" }),
        "observation"
      );
    })
  });
  readOnlyHost.notify(0);
  assert.equal(observed, 1);

  const issuedProbe = createSessionProbe();
  const issued = createWorldRuntimeControllerAuthority({}, {
    dynamics: issuedProbe.session,
    operation: {
      close: () => {},
      enter: () => {},
      leave: () => {}
    }
  });
  assert.equal(isWorldRuntimeControllerAuthority(issued), true);
  assert.doesNotThrow(() => createDynamicsRunActionSourceHost({
    participantHost: { controller: issued },
    session: issuedProbe.session,
    source: source(() => {})
  }));
});
