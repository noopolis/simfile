import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { CausalEvent } from "@noopolis/stele";

import { readWorldEvidence } from "./worldEvidence.js";

const writeJsonl = async (dir: string, relative: string, rows: readonly unknown[]): Promise<void> => {
  const file = path.join(dir, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : ""));
};

const causalPossession = (tick: number): CausalEvent => ({
  cause_event_ids: [], emitter: { seq: tick + 1, stream_id: "world", system: "simfile" },
  event_id: `possession-${tick}`, payload: { payload: { tick, value: `holder-${tick}` } },
  principal_id: "system:world", recorded_at: "2026-01-01T00:00:00.000Z", run_id: "test-run", type: "example.possession",
  version: "noopolis.causal-event.v1"
} as CausalEvent);

describe("readWorldEvidence", () => {
  it("derives the optional evidence section and does not fail on empty refusals", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "simfile-world-evidence-"));
    try {
      await writeJsonl(dir, "raw/action-results.jsonl", [{ result: { action: "move", origin: "agentic", principal_id: "principal:a", sequence: 1 } }]);
      await writeJsonl(dir, "raw/action-attempts.jsonl", [{ attempt: { action: "move", origin: "agentic", principal_id: "principal:a", at_tick: 0 }, receipt: { sequence: 1 } }]);
      await writeJsonl(dir, "raw/world/perception.jsonl", [{ principal: "principal:a", decision_id: "decision-1" }]);
      await writeJsonl(dir, "raw/world/action-refusals.jsonl", []);
      await writeJsonl(dir, "raw/frames.jsonl", [
        { version: "header", sim_seconds_per_tick: 1 },
        { tick: 0, sim_seconds_advanced: 0, wall_elapsed_seconds: 0 },
        { tick: 1, sim_seconds_advanced: 1, wall_elapsed_seconds: 0.5 }
      ]);
      const perceptionEvent = {
        ...causalPossession(0), event_id: "perception-0", type: "world.perception.observed",
        payload: { principal: "principal:a", decision_id: "decision-1", sim_time: 0 }
      } as CausalEvent;
      const result = await readWorldEvidence(dir, [perceptionEvent, causalPossession(0)]);
      assert.equal(result.evidence?.verdict.passed, true);
      assert.deepEqual(result.evidence?.refusals, { count: 0, reasons: [] });
      assert.deepEqual(result.evidence?.perception, { count: 1, principals: ["principal:a"] });
      assert.equal(result.evidence?.possession.covered, true);
      assert.equal(result.evidence?.pace.kept_up, true);
      assert.equal((await readFile(path.join(dir, "raw/frames.jsonl"), "utf8")).length > 0, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a truncated trailing record and marks the verdict incomplete", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "simfile-world-evidence-incomplete-"));
    try {
      await writeJsonl(dir, "raw/world/perception.jsonl", [{ principal: "principal:a" }]);
      await writeJsonl(dir, "raw/frames.jsonl", [
        { version: "header", sim_seconds_per_tick: 1 },
        { tick: 0, sim_seconds_advanced: 0, wall_elapsed_seconds: 0 },
        { tick: 1, sim_seconds_advanced: 1, wall_elapsed_seconds: 0.5 }
      ]);
      const framesPath = path.join(dir, "raw/frames.jsonl");
      const complete = await readFile(framesPath, "utf8");
      await writeFile(framesPath, `${complete.trimEnd()}\n{\"tick\": 2, \"sim_seconds_advanced\":`, "utf8");

      const result = await readWorldEvidence(dir, []);

      assert.deepEqual(result.parseErrors, [{
        relativePath: "raw/frames.jsonl",
        line: 4,
        message: "invalid JSON: Unexpected end of JSON input"
      }]);
      assert.equal(result.evidence?.verdict.passed, false);
      assert.equal(result.evidence?.verdict.status, "incomplete");
      assert.match(result.evidence?.verdict.reasons.join("\n") ?? "", /incomplete record: raw\/frames\.jsonl:4:/u);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
