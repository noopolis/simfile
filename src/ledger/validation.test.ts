import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createCanonicalEventEnvelope, stableStringify, type LedgerEventEnvelopeInput } from "./stable.js";
import {
  createCanonicalLedgerEventValidator,
  parseCanonicalLedgerJsonl,
  validateCanonicalLedgerEvents
} from "./validation.js";

const canonicalEvent = (seq: number, overrides: Partial<LedgerEventEnvelopeInput> = {}) =>
  createCanonicalEventEnvelope({
    runId: "run-ledger",
    seq,
    kind: seq === 1 ? "clock.sync" : "world.message",
    simTime: (seq - 1) * 60,
    provenance: "mechanical",
    actor: "@world",
    target: seq === 1 ? "global" : "room:office:hall",
    scope: seq === 1 ? "global" : "room:office:hall",
    payload: { seq },
    ...overrides
  });

describe("validateCanonicalLedgerEvents", () => {
  it("accepts contiguous canonical event envelopes", () => {
    const events = validateCanonicalLedgerEvents([canonicalEvent(1), canonicalEvent(2)], { runId: "run-ledger" });
    assert.equal(events.length, 2);
    assert.equal(events[1]?.event_id, "simfile:run-ledger:2");
    assert.equal(events[1]?.emitter?.stream_id, "world");
  });

  it("generalizes contiguity to (run_id, stream_id), allowing independent streams to interleave", () => {
    const worldOne = canonicalEvent(1);
    const worldTwo = canonicalEvent(2);
    const agentOne = canonicalEvent(1, { streamId: "agent:alice" });
    const agentTwo = canonicalEvent(2, { streamId: "agent:alice" });

    const events = validateCanonicalLedgerEvents([worldOne, agentOne, worldTwo, agentTwo], { runId: "run-ledger" });
    assert.equal(events.length, 4);
    assert.deepEqual(events.map((event) => event.emitter?.stream_id), ["world", "agent:alice", "world", "agent:alice"]);
  });

  it("rejects malformed required fields", () => {
    assert.throws(
      () => validateCanonicalLedgerEvents([{ ...canonicalEvent(1), provenance: "unknown" }]),
      /invalid provenance/u
    );
    assert.throws(
      () => validateCanonicalLedgerEvents([{ ...canonicalEvent(1), payload: undefined }]),
      /missing payload|invalid/u
    );
    assert.throws(
      () => validateCanonicalLedgerEvents([{ ...canonicalEvent(2), event_id: "simfile:run-ledger:2" }]),
      /non-contiguous/u
    );
    assert.throws(
      () => validateCanonicalLedgerEvents([{ ...canonicalEvent(1), version: "other" }]),
      /invalid version/u
    );
    assert.throws(
      () => validateCanonicalLedgerEvents([{ ...canonicalEvent(1), cause_event_ids: undefined }]),
      /invalid cause_event_ids/u
    );
  });

  it("rejects a run_id mismatch across events", () => {
    assert.throws(
      () => validateCanonicalLedgerEvents([canonicalEvent(1), { ...canonicalEvent(2), run_id: "other-run" }]),
      /mismatched run_id/u
    );
  });

  it("validates contiguous causal references incrementally", () => {
    const validator = createCanonicalLedgerEventValidator({
      runId: "run-ledger",
      streamId: "world"
    });
    validator.validate(canonicalEvent(1));
    validator.validate(canonicalEvent(2, {
      causeEventIds: ["simfile:run-ledger:1"]
    }));
    assert.equal(validator.count, 2);
    assert.throws(
      () => validator.validate(canonicalEvent(3, {
        causeEventIds: ["simfile:run-ledger:4"]
      })),
      /unknown or non-prior cause_event_id/u
    );
    assert.equal(validator.count, 2);
  });

  it("leaves cause ids outside this run's own id space untouched", () => {
    // The identifier grammar for a cause id belongs to B169, not to retention:
    // the incremental validator may only reject a *self* reference that is not
    // prior. Externally supplied causes the runtime preserves verbatim, and ids
    // from another run, stay exactly as legal as they are without it.
    const validator = createCanonicalLedgerEventValidator({
      runId: "run-ledger",
      streamId: "world"
    });
    validator.validate(canonicalEvent(1, {
      causeEventIds: ["driver:turn:7", "simfile:other-run:99", "simfile:run-ledger:not-a-seq"]
    }));
    assert.equal(validator.count, 1);
  });
});

describe("parseCanonicalLedgerJsonl", () => {
  it("parses canonical sorted-key JSONL", () => {
    const source = `${stableStringify(canonicalEvent(1))}\n${stableStringify(canonicalEvent(2))}\n`;
    const events = parseCanonicalLedgerJsonl(source, { runId: "run-ledger" });
    assert.equal(events.length, 2);
  });

  it("rejects non-canonical JSONL and malformed lines", () => {
    assert.throws(
      () => parseCanonicalLedgerJsonl(`${JSON.stringify(canonicalEvent(1), null, 0)}\n`, { runId: "run-ledger" }),
      /not canonical/u
    );
    assert.throws(
      () => parseCanonicalLedgerJsonl("{not-json}\n"),
      /not valid JSON/u
    );
  });
});
