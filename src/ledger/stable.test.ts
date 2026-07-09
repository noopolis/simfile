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
    assert.equal(envelope.event_id, "run-001:7");
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
    assert.equal(createEventId("run-001", 1), "run-001:1");
  });
});
