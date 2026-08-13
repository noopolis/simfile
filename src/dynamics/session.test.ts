import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadDynamicsSession } from "./load.js";
import {
  dynamicsRetainedActionCapacityMessage,
  issueDynamicsRetainedActionCapacityError,
  isDynamicsRetainedActionCapacityError
} from "./retainedCapacity.js";
import { isDynamicsRetryableStepFailure } from "./session.js";
import { counterAction, counterObservationRequest, createDynamicsTestProject, removeDynamicsTestProject } from "./testSupport.test-helper.js";

describe("DynamicsSession", () => {
  it("recognizes only issued permanent ingress-capacity errors", () => {
    for (const kind of ["records", "code_units"] as const) {
      const issued = issueDynamicsRetainedActionCapacityError(kind);
      assert.equal(issued.kind, kind);
      assert.equal(issued.message, dynamicsRetainedActionCapacityMessage(kind));
      assert.equal(isDynamicsRetainedActionCapacityError(issued), true);
      assert.equal(isDynamicsRetainedActionCapacityError(new Error(issued.message)), false);
      assert.equal(isDynamicsRetainedActionCapacityError({ name: issued.name, kind }), false);
      class ErrorSubclassLookalike extends Error {
        readonly kind = issued.kind;

        constructor() {
          super(issued.message);
          this.name = issued.name;
        }
      }
      assert.equal(isDynamicsRetainedActionCapacityError(new ErrorSubclassLookalike()), false);
    }
  });

  it("queues authenticated commands and applies them atomically at a fixed tick", async () => {
    const project = await createDynamicsTestProject();
    try {
      const session = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath });
      assert.ok(session);
      assert.equal(session.observe(counterObservationRequest).channels[0]?.components.value, 2);

      assert.deepEqual(session.queueAction(counterAction()), {
        act_id: "act-1",
        apply_tick: 0,
        queued: true,
        sequence: 1
      });
      assert.deepEqual(session.queueAction(counterAction()), {
        act_id: "act-1",
        apply_tick: 0,
        queued: true,
        sequence: 1
      });
      assert.deepEqual(session.queueAction(counterAction({ input: { amount: 99 } })), {
        act_id: "act-1",
        apply_tick: 0,
        code: "act_id_conflict",
        queued: false
      });
      assert.deepEqual(session.queueAction(counterAction({
        actor: "agent:blue",
        principal_id: "moltnet:blue"
      })), {
        act_id: "act-1",
        apply_tick: 0,
        queued: true,
        sequence: 2
      });
      const wrongTick = {
        act_id: "future",
        apply_tick: 0,
        code: "wrong_tick",
        queued: false
      } as const;
      assert.deepEqual(session.queueAction(counterAction({ act_id: "future", at_tick: 2 })), wrongTick);
      assert.deepEqual(session.queueAction(counterAction({ act_id: "future", at_tick: 2 })), wrongTick);

      const ingressEvidence = session.readActionIngressEvidence(0);
      assert.deepEqual(
        ingressEvidence.map((entry) => entry.ordinal),
        [1, 2, 3]
      );
      assert.deepEqual(
        ingressEvidence.map((entry) => entry.record.receipt.code ?? "queued"),
        ["queued", "queued", "wrong_tick"]
      );
      session.acknowledgeActionIngressEvidence(3);
      assert.deepEqual(session.readActionIngressEvidence(0), []);

      const step = session.step();
      assert.deepEqual(step.action_results.map((result) => ({
        accepted: result.accepted,
        act_id: result.act_id,
        sequence: result.sequence
      })), [
        { accepted: true, act_id: "act-1", sequence: 1 },
        { accepted: true, act_id: "act-1", sequence: 2 }
      ]);
      assert.deepEqual(step.events.map((event) => ({
        causes: event.cause_action_sequences,
        provenance: event.provenance,
        sequence: event.event_sequence,
        tick: event.tick
      })), [
        { causes: [1], provenance: "mechanical", sequence: 1, tick: 0 },
        { causes: [2], provenance: "mechanical", sequence: 2, tick: 0 }
      ]);
      const observation = session.observe(counterObservationRequest);
      assert.equal(observation.version, "simfile.numeric-observation.v1");
      assert.equal(observation.tick, 1);
      assert.equal(observation.channels[0]?.components.value, 8);
      assert.equal(observation.channels[0]?.components.last_dt_seconds, 0.5);
      assert.equal(observation.channels[0]?.components.sim_seconds_per_tick, 0.5);
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("restores pending inputs and replays the same continuation exactly", async () => {
    const project = await createDynamicsTestProject();
    try {
      const session = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath });
      assert.ok(session);
      session.queueAction(counterAction());
      const originalReceipt = session.queueAction(counterAction());
      session.step();
      const checkpoint = session.snapshot();

      session.queueAction(counterAction({ act_id: "act-2", at_tick: 1, input: { amount: 4 } }));
      const firstStep = session.step();
      const firstObservation = session.observe(counterObservationRequest);
      const firstFinal = session.snapshot();

      session.restore(checkpoint);
      assert.deepEqual(session.queueAction(counterAction()), {
        act_id: originalReceipt.act_id,
        apply_tick: 1,
        code: "wrong_tick",
        queued: false
      });
      session.restore(checkpoint);
      session.queueAction(counterAction({ act_id: "act-2", at_tick: 1, input: { amount: 4 } }));
      assert.deepEqual(session.step(), firstStep);
      assert.deepEqual(session.observe(counterObservationRequest), firstObservation);
      assert.deepEqual(session.snapshot(), firstFinal);
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("filters observation channels by exact granted sense address", async () => {
    const project = await createDynamicsTestProject(`
export const createDynamicsProvider = () => {
  let state = { value: 1 };
  return {
    api_version: "simfile.dynamics-provider.v1",
    id: "leaky",
    version: "1",
    state_schema_version: "v1",
    initialize() {},
    observe() { return { channels: [{
      components: { value: state.value },
      sense_address: "sense:secret",
      subject_address: "object:secret"
    }] }; },
    restore(value) { state = structuredClone(value); },
    snapshot() { return structuredClone(state); },
    step(input) { return { action_results: [], events: [], tick: input.tick }; }
  };
};
`);
    try {
      const session = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath });
      assert.ok(session);
      await assert.rejects(async () => session.observe(counterObservationRequest), /ungranted sense address/u);
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("does not let a provider widen frozen sense grants", async () => {
    const project = await createDynamicsTestProject(`
export const createDynamicsProvider = () => {
  let state = { value: 1 };
  return {
    api_version: "simfile.dynamics-provider.v1",
    id: "grant-mutator",
    version: "1",
    state_schema_version: "v1",
    initialize() {},
    observe(request) {
      try { request.sense_addresses.push("sense:secret"); } catch {}
      return { channels: [{
        components: { value: state.value },
        sense_address: "sense:secret",
        subject_address: "object:secret"
      }] };
    },
    restore(value) { state = structuredClone(value); },
    snapshot() { return structuredClone(state); },
    step(input) { return { action_results: [], events: [], tick: input.tick }; }
  };
};
`);
    try {
      const session = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath });
      assert.ok(session);
      assert.throws(() => session.observe(counterObservationRequest), /ungranted sense address/u);
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("allows one granted sense to compose numeric channels for multiple subjects", async () => {
    const project = await createDynamicsTestProject(`
export const createDynamicsProvider = () => {
  let state = { value: 1 };
  return {
    api_version: "simfile.dynamics-provider.v1",
    id: "composed-sense",
    version: "1",
    state_schema_version: "v1",
    initialize() {},
    observe() { return { channels: [
      { components: { x: 2 }, sense_address: "sense:counter", subject_address: "object:z" },
      { components: { x: 1 }, sense_address: "sense:counter", subject_address: "object:a" }
    ] }; },
    restore(value) { state = structuredClone(value); },
    snapshot() { return structuredClone(state); },
    step(input) { return { action_results: [], events: [], tick: input.tick }; }
  };
};
`);
    try {
      const session = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath });
      assert.ok(session);
      assert.deepEqual(
        session.observe(counterObservationRequest).channels.map((channel) => channel.subject_address),
        ["object:a", "object:z"]
      );
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("rolls back observation mutation and malformed step output", async () => {
    const project = await createDynamicsTestProject(`
export const createDynamicsProvider = () => {
  let state = { value: 0 };
  return {
    api_version: "simfile.dynamics-provider.v1",
    id: "malformed",
    version: "1",
    state_schema_version: "v1",
    initialize() {},
    observe() { state.value += 1; return { channels: [] }; },
    restore(value) { state = structuredClone(value); },
    snapshot() { return structuredClone(state); },
    step(input) { state.value += 10; return { action_results: [], events: [], tick: input.tick }; }
  };
};
`);
    try {
      const session = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath });
      assert.ok(session);
      const initial = session.snapshot();
      assert.throws(() => session.observe(counterObservationRequest), /must not mutate state/u);
      assert.deepEqual(session.snapshot(), initial);

      session.queueAction(counterAction());
      const queued = session.snapshot();
      assert.throws(() => session.step(), /resolve every queued action/u);
      assert.deepEqual(session.snapshot(), queued);
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("classifies only an issued provider-step throw after successful rollback", async () => {
    const sentinelKey = "__simfile_retryable_step_identity_test__";
    const sentinel = Object.freeze({ provider: "secret", state: { restores: 0 } });
    const project = await createDynamicsTestProject(`
export const createDynamicsProvider = () => {
  let throwStep = true;
  let state = { value: 0 };
  return { api_version: "simfile.dynamics-provider.v1", id: "retry-marker", version: "1", state_schema_version: "v1",
    initialize() {}, observe() { return { channels: [] }; }, restore(value) { Reflect.get(globalThis, "__simfile_retryable_step_identity_test__").state.restores += 1; state = structuredClone(value); }, snapshot() { return structuredClone(state); },
    step(input) { if (throwStep) { throwStep = false; throw Reflect.get(globalThis, "__simfile_retryable_step_identity_test__"); } state.value += 1; return { action_results: [], events: [], tick: input.tick }; }
  };
};`);
    try {
      Reflect.set(globalThis, sentinelKey, sentinel);
      const session = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath }); assert.ok(session);
      const before = session.snapshot();
      let issued: unknown;
      try { session.step(); } catch (error) { issued = error; }
      assert.equal(isDynamicsRetryableStepFailure(issued), true);
      assert.strictEqual((issued as Error).cause, sentinel);
      assert.equal(sentinel.state.restores, 1);
      assert.equal(isDynamicsRetryableStepFailure(new Error((issued as Error).message)), false);
      assert.equal(isDynamicsRetryableStepFailure({ name: (issued as Error).name, message: (issued as Error).message }), false);
      assert.equal(isDynamicsRetryableStepFailure(new Proxy(issued as object, {})), false);
      assert.equal(isDynamicsRetryableStepFailure("checked step failed"), false);
      assert.deepEqual(session.snapshot(), before);
      assert.equal(session.step().tick, 0);
    } finally { Reflect.deleteProperty(globalThis, sentinelKey); await removeDynamicsTestProject(project); }
  });

  it("retains primitive provider throws as retryable causes", async () => {
    const project = await createDynamicsTestProject(`
export const createDynamicsProvider = () => {
  let throwStep = true;
  return { api_version: "simfile.dynamics-provider.v1", id: "primitive-retry", version: "1", state_schema_version: "v1",
    initialize() {}, observe() { return { channels: [] }; }, restore() {}, snapshot() { return {}; },
    step(input) { if (throwStep) { throwStep = false; throw "provider primitive"; } return { action_results: [], events: [], tick: input.tick }; }
  };
};`);
    try {
      const session = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath }); assert.ok(session);
      let issued: unknown;
      try { session.step(); } catch (error) { issued = error; }
      assert.equal((issued as Error).cause, "provider primitive");
      assert.equal(isDynamicsRetryableStepFailure(issued), true);
      assert.equal(session.step().tick, 0);
    } finally { await removeDynamicsTestProject(project); }
  });

  it("does not classify checked output or rollback failure", async () => {
    const malformed = await createDynamicsTestProject(`
export const createDynamicsProvider = () => ({ api_version: "simfile.dynamics-provider.v1", id: "bad-output", version: "1", state_schema_version: "v1", initialize() {}, observe() { return { channels: [] }; }, restore() {}, snapshot() { return {}; }, step() { return { action_results: [{ accepted: true, sequence: 1 }], events: [], tick: 0 }; } });`);
    try { const session = await loadDynamicsSession(malformed.simfile, { simfilePath: malformed.simfilePath }); assert.ok(session); let error: unknown; try { session.step(); } catch (caught) { error = caught; } assert.equal(isDynamicsRetryableStepFailure(error), false); } finally { await removeDynamicsTestProject(malformed); }
    const broken = await createDynamicsTestProject(`
export const createDynamicsProvider = () => ({ api_version: "simfile.dynamics-provider.v1", id: "bad-rollback", version: "1", state_schema_version: "v1", initialize() {}, observe() { return { channels: [] }; }, restore() { throw new Error("restore failed"); }, snapshot() { return {}; }, step() { throw new Error("step failed"); } });`);
    try { const session = await loadDynamicsSession(broken.simfile, { simfilePath: broken.simfilePath }); assert.ok(session); let error: unknown; try { session.step(); } catch (caught) { error = caught; } assert.equal(isDynamicsRetryableStepFailure(error), false); assert.throws(() => session.snapshot(), /permanently closed/u); } finally { await removeDynamicsTestProject(broken); }
  });

  it("passes immutable command copies while retaining host-stamped action identity", async () => {
    const project = await createDynamicsTestProject(`
export const createDynamicsProvider = () => {
  let state = { value: 0 };
  return {
    api_version: "simfile.dynamics-provider.v1",
    id: "command-boundary",
    version: "1",
    state_schema_version: "v1",
    initialize() {},
    observe() { return { channels: [] }; },
    restore(value) { state = structuredClone(value); },
    snapshot() { return structuredClone(state); },
    step(input) {
      const command = input.actions[0];
      const frozen = Object.isFrozen(input) && Object.isFrozen(input.actions)
        && Object.isFrozen(command) && Object.isFrozen(command.input);
      return {
        action_results: [{ accepted: true, sequence: command.sequence }],
        events: [{
          cause_action_sequences: [command.sequence],
          kind: "boundary.checked",
          payload: { command_keys: Object.keys(command).sort(), frozen },
          source: command.actor,
          target: command.target
        }],
        tick: input.tick
      };
    }
  };
};
`);
    try {
      const session = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath });
      assert.ok(session);
      session.queueAction(counterAction());
      const result = session.step();
      assert.equal(result.action_results[0]?.actor, "agent:red");
      assert.equal(result.action_results[0]?.principal_id, "moltnet:red");
      assert.equal(result.events[0]?.payload.frozen, true);
      assert.deepEqual(result.events[0]?.payload.command_keys, ["action", "actor", "input", "sequence", "target"]);
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("rejects restore under different provenance without changing state", async () => {
    const project = await createDynamicsTestProject();
    try {
      const session = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath });
      assert.ok(session);
      const before = session.snapshot();
      const tampered = structuredClone(before);
      tampered.provenance.config_sha256 = "0".repeat(64);
      assert.throws(() => session.restore(tampered), /identity does not match/u);
      assert.deepEqual(session.snapshot(), before);
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("rejects internally inconsistent host snapshots before touching provider state", async () => {
    const project = await createDynamicsTestProject();
    try {
      const session = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath });
      assert.ok(session);
      session.queueAction(counterAction());
      const before = session.snapshot();

      const badSequence = structuredClone(before);
      badSequence.next_action_sequence = 8;
      assert.throws(() => session.restore(badSequence), /contiguous/u);

      const badTick = structuredClone(before);
      if (badTick.pending_actions[0]) badTick.pending_actions[0].at_tick = 1;
      assert.throws(() => session.restore(badTick), /next_tick/u);

      const badReceipt = structuredClone(before);
      if (badReceipt.action_ingress[0]?.receipt) badReceipt.action_ingress[0].receipt.sequence = 9;
      assert.throws(() => session.restore(badReceipt), /contiguous|ingress receipt/u);
      assert.deepEqual(session.snapshot(), before);
    } finally {
      await removeDynamicsTestProject(project);
    }
  });
});
