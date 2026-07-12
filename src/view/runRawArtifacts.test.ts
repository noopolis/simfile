import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { hasVariableSamples, normalizeRawTranscript, readTranscript, readWorldTelemetry } from "./runRawArtifacts.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = path.resolve(here, "..", "..", "fixtures", "observe", "office-sim-golden");
const WORLD_GOLDEN_DIR = path.resolve(here, "..", "..", "fixtures", "observe", "office-secret-v0-golden");
const VARIABLE_GOLDEN_DIR = path.resolve(here, "..", "..", "fixtures", "observe", "office-pressure-v0-golden");
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

describe("readWorldTelemetry / hasVariableSamples (increment 3/4: the variable gauge's data source)", () => {
  it("returns null for a run with no world/telemetry.json at all (office-sim-golden)", async () => {
    const samples = await readWorldTelemetry(GOLDEN_DIR);
    assert.equal(samples, null);
    assert.equal(hasVariableSamples(samples), false);
  });

  it("parses office-secret-v0-golden's telemetry but reports no real variable samples (every sample's variables map is empty)", async () => {
    const samples = await readWorldTelemetry(WORLD_GOLDEN_DIR);
    assert.ok(samples);
    assert.equal(samples!.length, 2);
    assert.deepEqual(samples![0]!.variables, {});
    assert.equal(hasVariableSamples(samples), false);
  });

  it("parses office-pressure-v0-golden's telemetry and reports a real, ramping filing_pressure sample set", async () => {
    const samples = await readWorldTelemetry(VARIABLE_GOLDEN_DIR);
    assert.ok(samples);
    assert.equal(hasVariableSamples(samples), true);
    assert.deepEqual(
      samples!.map((sample) => ({ tick: sample.tick, filing_pressure: sample.variables.filing_pressure })),
      [
        { tick: 0, filing_pressure: 0.7 },
        { tick: 1, filing_pressure: 1 },
        { tick: 2, filing_pressure: 1 },
      ],
    );
    // Never a fabricated/rounded value — real numbers straight off the run's
    // own world/telemetry.json, ramping strictly (0.7 -> 1.0) before it clamps.
    assert.ok(samples![0]!.variables.filing_pressure! < samples![1]!.variables.filing_pressure!);
  });
});
