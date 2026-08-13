import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canonicalDynamicsJson } from "./canonicalJson.js";
import { DYNAMICS_ACTION_RETENTION_LIMITS, DYNAMICS_LIMITS } from "./limits.js";
import { loadDynamicsSession } from "./load.js";
import {
  dynamicsRetainedActionCapacityMessage,
  isDynamicsRetainedActionCapacityError
} from "./retainedCapacity.js";
import { readCheckedDynamicsSession } from "./session.js";
import {
  counterAction,
  counterObservationRequest,
  createDynamicsTestProject,
  removeDynamicsTestProject
} from "./testSupport.test-helper.js";

describe("DynamicsSession hardening", () => {
  it("issues frozen module-attested sessions rather than structural lookalikes", async () => {
    const project = await createDynamicsTestProject();
    try {
      const session = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath });
      assert.ok(session);
      assert.equal(readCheckedDynamicsSession(session), session);
      assert.equal(readCheckedDynamicsSession({ ...session }), undefined);
      assert.equal(readCheckedDynamicsSession(new Proxy(session, {})), undefined);
      assert.equal(Object.isFrozen(session), true);
      assert.throws(() => { (session as unknown as { step: unknown }).step = undefined; }, TypeError);
      assert.throws(() => Object.setPrototypeOf(session, {}), TypeError);
    } finally {
      await removeDynamicsTestProject(project);
    }
  });
  it("permanently closes when provider rollback cannot restore state", async () => {
    const project = await createDynamicsTestProject(`
export const createDynamicsProvider = () => {
  let state = { value: 0 };
  return {
    api_version: "simfile.dynamics-provider.v1",
    id: "broken-rollback",
    version: "1",
    state_schema_version: "v1",
    initialize() {},
    observe() { return { channels: [] }; },
    restore() { throw new Error("restore is broken"); },
    snapshot() { return structuredClone(state); },
    step(input) { state.value += 1; return { action_results: [], events: [], tick: input.tick }; }
  };
};
`);
    try {
      const session = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath });
      assert.ok(session);
      const checkpoint = session.snapshot();
      session.queueAction(counterAction());
      assert.throws(() => session.step(), /operation and rollback both failed/u);
      for (const operation of [
        () => session.integration,
        () => session.nextTick,
        () => session.provenance,
        () => session.queueAction(counterAction({ act_id: "later" })),
        () => session.observe(counterObservationRequest),
        () => session.step(),
        () => session.snapshot(),
        () => session.restore(checkpoint)
      ]) assert.throws(operation, /permanently closed/u);
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("surfaces both operation and rollback errors", async () => {
    const project = await createDynamicsTestProject(`
export const createDynamicsProvider = () => ({
  api_version: "simfile.dynamics-provider.v1",
  id: "double-failure",
  version: "1",
  state_schema_version: "v1",
  initialize() {},
  observe() { return { channels: [] }; },
  restore() { throw new Error("distinctive restore failure"); },
  snapshot() { return { value: 0 }; },
  step() { throw new Error("distinctive operation failure"); }
});
`);
    try {
      const session = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath });
      assert.ok(session);
      assert.throws(
        () => session.step(),
        (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.errors.length, 2);
          assert.match(error.message, /distinctive operation failure/u);
          assert.match(error.message, /distinctive restore failure/u);
          return true;
        }
      );
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("uses safe counters and refuses another tick before exhaustion", async () => {
    const project = await createDynamicsTestProject();
    try {
      const session = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath });
      assert.ok(session);
      const checkpoint = session.snapshot();
      for (const field of ["next_tick", "next_event_sequence", "next_action_sequence"] as const) {
        const unsafe = structuredClone(checkpoint);
        unsafe[field] = 2 ** 53;
        assert.throws(() => session.restore(unsafe), /safe integer/u);
      }
      assert.throws(
        () => session.queueAction(counterAction({ act_id: "unsafe", at_tick: 2 ** 53 })),
        /safe integer/u
      );

      const exhausted = structuredClone(checkpoint);
      exhausted.next_tick = Number.MAX_SAFE_INTEGER;
      session.restore(exhausted);
      assert.throws(() => session.step(), /tick counter exhausted/u);
      assert.equal(session.nextTick, Number.MAX_SAFE_INTEGER);

      const hugeClock = {
        ...project.simfile,
        clock: { ...project.simfile.clock, sim_per_tick: `${`1${"0".repeat(307)}`}ms` }
      };
      const hugeTime = await loadDynamicsSession(hugeClock, { simfilePath: project.simfilePath });
      assert.ok(hugeTime);
      const late = hugeTime.snapshot();
      late.next_tick = 100_000;
      hugeTime.restore(late);
      assert.throws(() => hugeTime.step(), /sim_time must remain finite/u);
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("enforces identifier and provider-message code-unit limits", async () => {
    const project = await createDynamicsTestProject(`
export const createDynamicsProvider = () => {
  let state = { value: 0 };
  return {
    api_version: "simfile.dynamics-provider.v1", id: "text-limits", version: "1", state_schema_version: "v1",
    initialize() {}, observe() { return { channels: [] }; }, restore(value) { state = structuredClone(value); },
    snapshot() { return structuredClone(state); },
    step(input) { return { action_results: input.actions.map((action) => ({
      accepted: true, message: "x".repeat(${DYNAMICS_LIMITS.message_code_units + 1}), sequence: action.sequence
    })), events: [], tick: input.tick }; }
  };
};
`);
    try {
      const session = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath });
      assert.ok(session);
      assert.throws(
        () => session.queueAction(counterAction({ act_id: "x".repeat(DYNAMICS_LIMITS.identifier_code_units + 1) })),
        /256 code-unit limit/u
      );
      session.queueAction(counterAction({ act_id: "x".repeat(DYNAMICS_LIMITS.identifier_code_units) }));
      assert.throws(() => session.step(), /4096 code-unit limit/u);
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("enforces pending, retained-history, and sense-grant fuses", async () => {
    const project = await createDynamicsTestProject();
    try {
      const session = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath });
      assert.ok(session);
      for (let index = 0; index < DYNAMICS_LIMITS.actions_per_tick; index += 1) {
        session.queueAction(counterAction({ act_id: `act-${index}` }));
        session.acknowledgeActionIngressEvidence(index + 1);
      }
      assert.throws(
        () => session.queueAction(counterAction({ act_id: "overflow" })),
        /pending action limit/u
      );
      assert.throws(() => session.observe({
        observer: "agent:red",
        principal_id: "moltnet:red",
        sense_addresses: Array.from(
          { length: DYNAMICS_LIMITS.sense_grants + 1 },
          (_, index) => `sense:s${index}`
        )
      }), /sense grant limit/u);

      const oversized = session.snapshot() as unknown as { action_ingress: unknown[] };
      oversized.action_ingress = new Array(DYNAMICS_ACTION_RETENTION_LIMITS.records + 1);
      assert.throws(() => session.restore(oversized), /retained ingress limit/u);
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("bounds multiplicative action input and retained ingress code units", async () => {
    const project = await createDynamicsTestProject();
    try {
      const session = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath });
      assert.ok(session);
      const multiplicative = Object.fromEntries(Array.from(
        { length: Math.floor(DYNAMICS_LIMITS.json_code_units / 1_000) + 1 },
        (_, index) => [`value_${index}`, "x".repeat(1_000)]
      ));
      assert.throws(
        () => session.queueAction(counterAction({ input: multiplicative })),
        /cumulative.*code-unit limit/u
      );
      assert.equal(session.snapshot().action_ingress.length, 0);

      const frontier = session.snapshot();
      const sequenceFloor = Number.MAX_SAFE_INTEGER - DYNAMICS_LIMITS.actions_per_tick;
      frontier.accepted_action_sequences.floor = sequenceFloor;
      frontier.action_ingress_floor = sequenceFloor;
      frontier.next_action_sequence = sequenceFloor;
      frontier.next_tick = Number.MAX_SAFE_INTEGER - 1;
      frontier.resolved_action_sequences.floor = sequenceFloor;
      session.restore(frontier);
      const escaped = Array.from({ length: 32 }, (_, code) => String.fromCharCode(code))
        .filter((value) => JSON.stringify(value).length === 8);
      assert.ok(escaped.length * escaped.length >= DYNAMICS_LIMITS.actions_per_tick);
      let evidenceOrdinal = 0;
      for (let index = 0; index < DYNAMICS_LIMITS.actions_per_tick; index += 1) {
        const suffix = escaped[Math.floor(index / escaped.length)] + escaped[index % escaped.length];
        const identity = "\0".repeat(DYNAMICS_LIMITS.identifier_code_units - 2) + suffix;
        session.queueAction(counterAction({
          act_id: identity,
          at_tick: Number.MAX_SAFE_INTEGER - 1,
          principal_id: identity
        }));
        const evidence = session.readActionIngressEvidence(evidenceOrdinal);
        assert.equal(evidence.length, 1);
        evidenceOrdinal = evidence[0]?.ordinal ?? evidenceOrdinal;
        session.acknowledgeActionIngressEvidence(evidenceOrdinal);
      }
      const checkpoint = session.snapshot();
      const retainedCodeUnits = checkpoint.action_ingress.reduce(
        (total, record) => total + canonicalDynamicsJson(record).length,
        0
      );
      assert.equal(checkpoint.action_ingress.length, DYNAMICS_ACTION_RETENTION_LIMITS.records);
      assert.ok(checkpoint.action_ingress.every((record) =>
        canonicalDynamicsJson(record).length === DYNAMICS_ACTION_RETENTION_LIMITS.record_code_units));
      assert.equal(retainedCodeUnits, DYNAMICS_ACTION_RETENTION_LIMITS.code_units);
      assert.equal(checkpoint.pending_actions.length, DYNAMICS_LIMITS.actions_per_tick);

      const rejected = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath });
      assert.ok(rejected);
      for (let index = 0; index < DYNAMICS_ACTION_RETENTION_LIMITS.records; index += 1) {
        rejected.queueAction(counterAction({ act_id: `rejected-${index}`, at_tick: 1 }));
        rejected.acknowledgeActionIngressEvidence(index + 1);
      }
      assert.throws(
        () => rejected.queueAction(counterAction({ act_id: "retained-overflow", at_tick: 1 })),
        (error) => isDynamicsRetainedActionCapacityError(error)
          && error.kind === "records"
          && error.message === dynamicsRetainedActionCapacityMessage("records")
      );
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("bounds multiplicative snapshot, event, and observation values", async () => {
    const multiplicative = Object.fromEntries(Array.from(
      { length: Math.floor(DYNAMICS_LIMITS.json_code_units / 1_000) + 1 },
      (_, index) => [`value_${index}`, "x".repeat(1_000)]
    ));
    const snapshotProject = await createDynamicsTestProject();
    try {
      const session = await loadDynamicsSession(snapshotProject.simfile, {
        simfilePath: snapshotProject.simfilePath
      });
      assert.ok(session);
      const snapshot = session.snapshot();
      snapshot.provider_state = multiplicative;
      assert.throws(() => session.restore(snapshot), /cumulative.*code-unit limit/u);
    } finally {
      await removeDynamicsTestProject(snapshotProject);
    }

    for (const [source, operation] of [[`
export const createDynamicsProvider = () => {
  let state = { value: 0 };
  return {
    api_version: "simfile.dynamics-provider.v1", id: "large-event", version: "1", state_schema_version: "v1",
    initialize() {}, observe() { return { channels: [] }; }, restore(value) { state = structuredClone(value); },
    snapshot() { return structuredClone(state); },
    step(input) { return { action_results: [], events: [{
      cause_action_sequences: [], kind: "large.event",
      payload: Object.fromEntries(Array.from({ length: ${Math.floor(DYNAMICS_LIMITS.json_code_units / 1_000) + 1} }, (_, index) => ["v" + index, "x".repeat(1000)])),
      source: "system:test", target: "object:test"
    }], tick: input.tick }; }
  };
};
`, "step"], [`
export const createDynamicsProvider = () => {
  let state = { value: 0 };
  return {
    api_version: "simfile.dynamics-provider.v1", id: "large-observation", version: "1", state_schema_version: "v1",
    initialize() {}, restore(value) { state = structuredClone(value); }, snapshot() { return structuredClone(state); },
    observe() { return { channels: Array.from({ length: ${DYNAMICS_LIMITS.observation_channels} }, (_, index) => ({
      components: { value: index }, sense_address: "sense:counter",
      subject_address: "object:o" + index + "x".repeat(240 - String(index).length)
    })) }; },
    step(input) { return { action_results: [], events: [], tick: input.tick }; }
  };
};
`, "observe"]] as const) {
      const project = await createDynamicsTestProject(source);
      try {
        const session = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath });
        assert.ok(session);
        assert.throws(
          () => operation === "step" ? session.step() : session.observe(counterObservationRequest),
          /cumulative.*code-unit limit/u
        );
      } finally {
        await removeDynamicsTestProject(project);
      }
    }
  });

  it("enforces provider event and cause fuses transactionally", async () => {
    for (const [source, expected] of [
      [`
export const createDynamicsProvider = () => {
  let state = { value: 0 };
  return {
    api_version: "simfile.dynamics-provider.v1", id: "event-fuse", version: "1", state_schema_version: "v1",
    initialize() {}, observe() { return { channels: [] }; }, restore(value) { state = structuredClone(value); },
    snapshot() { return structuredClone(state); },
    step(input) { state.value += 1; return {
      action_results: [],
      events: Array.from({ length: ${DYNAMICS_LIMITS.events_per_tick + 1} }, () => ({
        cause_action_sequences: [], kind: "fuse.event", payload: {}, source: "system:test", target: "object:test"
      })), tick: input.tick
    }; }
  };
};
`, /event limit/u],
      [`
export const createDynamicsProvider = () => {
  let state = { value: 0 };
  return {
    api_version: "simfile.dynamics-provider.v1", id: "cause-fuse", version: "1", state_schema_version: "v1",
    initialize() {}, observe() { return { channels: [] }; }, restore(value) { state = structuredClone(value); },
    snapshot() { return structuredClone(state); },
    step(input) { state.value += 1; return {
      action_results: [{ accepted: true, sequence: input.actions[0].sequence }],
      events: [{ cause_action_sequences: Array.from({ length: ${DYNAMICS_LIMITS.causes_per_event + 1} }, () => 1),
        kind: "fuse.cause", payload: {}, source: "system:test", target: "object:test" }], tick: input.tick
    }; }
  };
};
`, /cause limit/u]
    ] as const) {
      const project = await createDynamicsTestProject(source);
      try {
        const session = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath });
        assert.ok(session);
        if (source.includes("cause-fuse")) session.queueAction(counterAction());
        const before = session.snapshot();
        assert.throws(() => session.step(), expected);
        assert.deepEqual(session.snapshot(), before);
      } finally {
        await removeDynamicsTestProject(project);
      }
    }
  });

  it("rejects resolved and rejected receipts with impossible temporal positions", async () => {
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

  it("orders ingress by sequence and rejects pending/resolved chronology inversion", async () => {
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
    } finally {
      await removeDynamicsTestProject(project);
    }
  });
});
