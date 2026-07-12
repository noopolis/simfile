import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { normalizeRawTranscript, readTranscript } from "./runRawArtifacts.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = path.resolve(here, "..", "..", "fixtures", "observe", "office-sim-golden");
const REAL_RUN_DIR = path.resolve(
  here,
  "..",
  "..",
  "runs",
  "real-grok-composed",
  "run-b7ef07f0fd2c4779894c2bb746140972",
);

describe("readTranscript — normalizes both raw/moltnet/transcript.json shapes", () => {
  it("reads the golden fixture's {seedMessageText, transcript} shape", async () => {
    const result = await readTranscript(GOLDEN_DIR);
    assert.equal(result.transcript.length, 4);
    assert.equal(result.transcript[0]!.from.type, "human");
    assert.match(result.seedMessageText ?? "", /finalize the office pilot rollout/i);
  });

  it("normalizes the real composed run's {conversations:[{messages}]} export shape", async () => {
    const result = await readTranscript(REAL_RUN_DIR);
    assert.equal(result.transcript.length, 4);
    for (const message of result.transcript) {
      assert.equal(typeof message.id, "string");
      assert.equal(typeof message.from.id, "string");
      assert.equal(typeof message.from.type, "string");
      assert.ok(Array.isArray(message.parts));
      assert.equal(typeof message.created_at, "string");
    }
    assert.equal(result.transcript[0]!.from.id, "world");
  });

  it("produces the same internal field set from both shapes, with real grok dialogue present", async () => {
    const golden = await readTranscript(GOLDEN_DIR);
    const real = await readTranscript(REAL_RUN_DIR);
    assert.deepEqual(Object.keys(real.transcript[0]!).sort(), Object.keys(golden.transcript[0]!).sort());

    const realText = real.transcript.map((message) => message.parts.find((part) => part.kind === "text")?.text ?? "").join(" ");
    assert.match(realText, /Riverside Annex/);
    assert.match(realText, /Suite 204/);
    assert.match(realText, /July 28/);
  });

  it("flattens and re-sorts multi-conversation export shapes by created_at", () => {
    const result = normalizeRawTranscript({
      source: "moltnet-exported",
      version: "simfile.moltnet.transcript.v1",
      conversations: [
        {
          messages: [
            {
              id: "b",
              from: { type: "agent", id: "x", name: "x" },
              parts: [{ kind: "text", text: "second" }],
              created_at: "2026-01-01T00:00:02Z",
            },
          ],
        },
        {
          messages: [
            {
              id: "a",
              from: { type: "agent", id: "y", name: "y" },
              parts: [{ kind: "text", text: "first" }],
              created_at: "2026-01-01T00:00:01Z",
            },
          ],
        },
      ],
    });
    assert.deepEqual(result.transcript.map((message) => message.id), ["a", "b"]);
  });
});
