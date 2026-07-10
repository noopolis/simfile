import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createCanonicalEventEnvelope, createEventDigest, createEventId, stableEventLine, stableStringify } from "./stable.js";

describe("stableStringify", () => {
  it("sorts object keys before serializing", () => {
    assert.equal(
      stableStringify({ b: 2, a: 1, nested: { z: 3, a: 1 } }),
      JSON.stringify({ a: 1, b: 2, nested: { a: 1, z: 3 } })
    );
  });

  it("preserves array order", () => {
    assert.equal(stableStringify([3, 2, 1]), "[3,2,1]");
  });
});

describe("createCanonicalEventEnvelope", () => {
  it("normalizes event identity and drops non-canonical fields", () => {
    const envelope = createCanonicalEventEnvelope({
      runId: "run-001",
      seq: 7,
      kind: "world.message",
      simTime: 30,
      provenance: "mechanical",
      actor: "world",
      target: "room:office-floor:hall",
      scope: "room:office-floor:hall",
      payload: { content: "Hello" },
      observedAt: "2026-07-07T00:00:00Z"
    });
    assert.equal(envelope.event_id, "simfile:run-001:7");
    assert.deepEqual(stableEventLine({
      runId: "run-001",
      seq: 7,
      kind: "world.message",
      simTime: 30,
      provenance: "mechanical",
      actor: "world",
      target: "room:office-floor:hall",
      scope: "room:office-floor:hall",
      payload: { content: "Hello" },
      observedAt: "2026-07-07T00:00:00Z"
    }), stableStringify(envelope));
  });

  it("builds stable ids and deterministic digests", () => {
    const first = createEventDigest({
      runId: "run-001",
      seq: 1,
      kind: "rule.fired",
      simTime: 1,
      provenance: "mechanical",
      actor: "deadline_bites",
      target: "room:office-floor:hall",
      scope: "room:office-floor:hall",
      payload: { score: 1 }
    });
    const second = createEventDigest({
      runId: "run-001",
      seq: 1,
      kind: "rule.fired",
      simTime: 1,
      provenance: "mechanical",
      actor: "deadline_bites",
      target: "room:office-floor:hall",
      scope: "room:office-floor:hall",
      payload: { score: 1 }
    });
    assert.equal(first, second);
    assert.equal(createEventId("run-001", 1), "simfile:run-001:1");
  });

  it("stamps the causal envelope with version, emitter, principal, and cause fields", () => {
    const envelope = createCanonicalEventEnvelope({
      runId: "run-causal",
      seq: 3,
      kind: "world.message",
      simTime: 120,
      provenance: "mechanical",
      actor: "@world",
      target: "room:office-floor:hall",
      scope: "room:office-floor:hall",
      payload: { content: "hi" },
      causeEventIds: ["simfile:run-causal:2"]
    });

    assert.equal(envelope.version, "noopolis.causal-event.v1");
    assert.equal(envelope.run_id, "run-causal");
    assert.equal(envelope.event_id, "simfile:run-causal:3");
    assert.deepEqual(envelope.emitter, { system: "simfile", stream_id: "world", seq: 3 });
    assert.equal(envelope.principal_id, "system:simfile.world");
    assert.equal(typeof envelope.recorded_at, "string");
    assert.equal(Number.isNaN(Date.parse(envelope.recorded_at ?? "")), false);
    assert.deepEqual(envelope.cause_event_ids, ["simfile:run-causal:2"]);
  });

  it("defaults stream_id, principal_id, and cause_event_ids when omitted", () => {
    const envelope = createCanonicalEventEnvelope({
      runId: "run-defaults",
      seq: 1,
      kind: "clock.sync",
      simTime: 0,
      provenance: "mechanical",
      actor: "@world",
      target: "global",
      scope: "global",
      payload: { tick: 0 }
    });

    assert.equal(envelope.emitter?.stream_id, "world");
    assert.equal(envelope.principal_id, "system:simfile.world");
    assert.deepEqual(envelope.cause_event_ids, []);
  });

  it("rejects a non-positive seq", () => {
    assert.throws(() => createCanonicalEventEnvelope({
      runId: "run-invalid",
      seq: 0,
      kind: "clock.sync",
      simTime: 0,
      provenance: "mechanical",
      actor: "@world",
      target: "global",
      scope: "global",
      payload: {}
    }), /seq must be a positive integer/u);
  });
});
