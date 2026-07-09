import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluateTranscriptAcceptance } from "./transcripts.js";

describe("evaluateTranscriptAcceptance", () => {
  it("accepts only Moltnet-exported transcripts as social truth", () => {
    assert.deepEqual(evaluateTranscriptAcceptance({ source: "moltnet-exported" }), {
      accepted: true,
      required_source: "moltnet-exported",
      source: "moltnet-exported"
    });

    assert.deepEqual(evaluateTranscriptAcceptance({ source: "harness-derived" }), {
      accepted: false,
      reason: "live simulation acceptance requires a moltnet-exported transcript",
      required_source: "moltnet-exported",
      source: "harness-derived"
    });
  });

  it("treats missing or unknown transcript labels as unacceptable", () => {
    assert.equal(evaluateTranscriptAcceptance().accepted, false);
    assert.equal(evaluateTranscriptAcceptance({ source: "legacy" }).source, "unknown");
  });
});
