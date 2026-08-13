import assert from "node:assert/strict";
import test from "node:test";

import { readWorldRuntimeClockAuthority } from "./clockAuthority.js";
import {
  readWorldRuntimeControllerAuthority,
} from "./controllerAuthority.js";
import {
  runtimeActEnvelope,
  runtimeActionResultLedger,
  runtimeFixtureWithHooks,
} from "./runtime.test-helper.js";
import * as worldBarrel from "./index.js";
import * as packageBarrel from "../index.js";

test("queues controller motor work beside agent intent without crossing ledgers", () => {
  const fixture = runtimeFixtureWithHooks({
    step: (input) => {
      const value = input as {
        readonly actions: readonly { readonly sequence: number }[];
        readonly tick: number;
      };
      return {
        tick: value.tick,
        action_results: value.actions.map(({ sequence }) => ({
          accepted: true,
          sequence,
        })),
        events: [
          {
            cause_action_sequences: [value.actions[0]!.sequence],
            kind: "body.motion",
            payload: { distance: 1 },
            source: "object:red",
            target: "object:ball",
          },
          {
            cause_action_sequences: value.actions.map(({ sequence }) => sequence),
            kind: "impact",
            payload: { strength: 1 },
            source: "object:red",
            target: "object:ball",
          },
        ],
      };
    },
  });
  const controller = readWorldRuntimeControllerAuthority(fixture.runtime!);
  assert.ok(controller);
  const motor = controller.queue({
    action: "move",
    actor: "object:red",
    controller_id: "red-body",
    controller_version: "test-v1",
    input: { x: 1 },
    intent_id: "intent-red-1",
    policy: "intent",
    skill: "intercept",
    target: "object:red",
  });
  assert.equal(motor.queued, true);
  const intent = fixture.runtime!.act(
    {
      principal: "principal-red",
      decisionToken: fixture.red.token,
    },
    runtimeActEnvelope("intent-red-1", {
      affordance: "world://pitch/affordance/kick",
      target: "world://pitch/entity/ball",
      input: { force: 1 },
    }),
  );
  assert.equal(intent.disposition, "queued");
  const drained = readWorldRuntimeClockAuthority(fixture.runtime!)!.stepDynamics();
  assert.deepEqual(drained, { action_results: 2, events: 2, tick: 0 });
  assert.equal(drained.raw_step.action_results.length, 2);
  assert.equal(drained.raw_step.events.length, 2);
  assert.deepEqual(controller.inspect(), [{
    accepted: true,
    action: "move",
    actor: "object:red",
    controller_id: "red-body",
    controller_version: "test-v1",
    input: { x: 1 },
    intent_id: "intent-red-1",
    policy: "intent",
    skill: "intercept",
    target: "object:red",
    act_id: "controller:red-body:0",
    apply_tick: 0,
    event_kinds: ["body.motion", "impact"],
    sequence: 1,
    status: "applied",
  }]);
  const result = runtimeActionResultLedger(fixture.runtime!)!.read(
    "principal-red",
    { version: "simfile.world-action-result-page-request.v1" },
  ).results[0]!;
  assert.equal(result.status, "applied");
  assert.deepEqual(
    (result as Extract<typeof result, { status: "applied" }>).caused_effect_ids,
    ["world-effect-1"],
  );
});

test("controller authority is host-only and rejects malformed provenance", () => {
  const fixture = runtimeFixtureWithHooks({});
  const controller = readWorldRuntimeControllerAuthority(fixture.runtime!)!;
  assert.equal("controller" in fixture.runtime!, false);
  assert.equal("readWorldRuntimeControllerAuthority" in worldBarrel, false);
  assert.equal("readWorldRuntimeControllerAuthority" in packageBarrel, false);
  assert.throws(() => controller.queue({
    action: "move",
    actor: "object:red",
    controller_id: " red-body",
    controller_version: "test-v1",
    input: {},
    policy: "default",
    skill: "seek",
    target: "object:red",
  }));
  assert.deepEqual(controller.inspect(), []);
});

test("controller settlement preserves terminal commitment outcomes", () => {
  const fixture = runtimeFixtureWithHooks({});
  const controller = readWorldRuntimeControllerAuthority(fixture.runtime!)!;
  const outcomes = [{
    commitment_id: "commitment:red:1",
    declaration_action_sequence: 1,
    outcome: "expired" as const,
    participant: "object:red",
    provenance: "mechanical" as const,
    tick: 3,
  }];
  assert.deepEqual(controller.settle({
    action_results: [],
    commitment_outcomes: outcomes,
    events: [],
    tick: 3,
  }).commitment_outcomes, outcomes);
});

test("retryable mechanics failures preserve the queued controller action", () => {
  let fail = true;
  const fixture = runtimeFixtureWithHooks({
    step: (input) => {
      if (fail) {
        fail = false;
        throw new Error("provider retry");
      }
      const value = input as {
        readonly actions: readonly { readonly sequence: number }[];
        readonly tick: number;
      };
      return {
        action_results: value.actions.map(({ sequence }) => ({
          accepted: true,
          sequence,
        })),
        events: [],
        tick: value.tick,
      };
    },
  });
  const controller = readWorldRuntimeControllerAuthority(fixture.runtime!)!;
  const action = {
    action: "move",
    actor: "object:red",
    controller_id: "red-body",
    controller_version: "test-v1",
    input: {},
    policy: "default",
    skill: "seek",
    target: "object:red",
  } as const;
  const receipt = controller.queue(action);
  assert.deepEqual(controller.queue(action), receipt);
  assert.throws(
    () => readWorldRuntimeClockAuthority(fixture.runtime!)!.stepDynamics(),
    /checked step/u,
  );
  assert.equal(controller.inspect()[0]?.status, "queued");
  assert.equal(
    readWorldRuntimeClockAuthority(fixture.runtime!)!.stepDynamics().tick,
    0,
  );
  assert.equal(controller.inspect()[0]?.status, "applied");
});
