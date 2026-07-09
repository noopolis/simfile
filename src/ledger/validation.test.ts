import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { stableStringify } from "./stable.js";
import { parseCanonicalLedgerJsonl, validateCanonicalLedgerEvents } from "./validation.js";

const canonicalEvent = (seq: number) => ({
  event_id: `run-ledger:${seq}`,
  kind: seq === 1 ? "clock.sync" : "world.message",
  sim_time: (seq - 1) * 60,
  provenance: "mechanical",
  actor: "@world",
  target: seq === 1 ? "global" : "room:office:hall",
  scope: seq === 1 ? "global" : "room:office:hall",
  payload: { seq }
});

describe("validateCanonicalLedgerEvents", () => {
  it("accepts contiguous canonical event envelopes", () => {
    const events = validateCanonicalLedgerEvents([canonicalEvent(1), canonicalEvent(2)], { runId: "run-ledger" });
    assert.equal(events.length, 2);
    assert.equal(events[1]?.event_id, "run-ledger:2");
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
      () => validateCanonicalLedgerEvents([{ ...canonicalEvent(2), event_id: "run-ledger:2" }]),
      /non-contiguous/u
    );
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
