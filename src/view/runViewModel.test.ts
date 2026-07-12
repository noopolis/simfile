import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { buildRunViewModel } from "./runViewModel.js";

const GOLDEN_FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "observe",
  "office-sim-golden"
);

describe("buildRunViewModel — office-sim golden fixture", () => {
  it("builds a healthy verdict matching the reconciled observe report", async () => {
    const model = await buildRunViewModel(GOLDEN_FIXTURE_DIR);
    assert.equal(model.version, "simfile.run-view-model.v1");
    assert.equal(model.runId, "run-58fa4bd3beed42e5954517389dca2646");
    assert.deepEqual(model.participants, ["eleanor", "sam"]);
    assert.equal(model.verdict.healthy, true);
    assert.equal(model.verdict.turnCount, 3);
    assert.equal(model.verdict.chainsComplete, 18);
    assert.equal(model.verdict.chainsIncomplete, 0);
    assert.equal(model.verdict.artifactsVerified, model.verdict.artifactsTotal);
    assert.ok(model.verdict.artifactsTotal >= 6);
  });

  it("renders the thread as the seed message plus 3 agent turns", async () => {
    const model = await buildRunViewModel(GOLDEN_FIXTURE_DIR);
    assert.equal(model.thread.length, 4);

    const [seed, first, second, third] = model.thread;
    assert.equal(seed!.turn, null);
    assert.equal(seed!.agentId, null);
    assert.match(seed!.text, /finalize the office pilot rollout/i);

    assert.equal(first!.turn, 1);
    assert.equal(first!.agentId, "eleanor");
    assert.equal(second!.turn, 2);
    assert.equal(second!.agentId, "sam");
    assert.equal(third!.turn, 3);
    assert.equal(third!.agentId, "eleanor");
  });

  it("labels each turn's role by the @mention that woke it, not the prior author", async () => {
    const model = await buildRunViewModel(GOLDEN_FIXTURE_DIR);
    const [, first, second, third] = model.thread;

    // Turn 1 follows the seed, which is always "woken by seed" even though
    // the seed also @mentions eleanor.
    assert.equal(first!.role, "woken by seed");
    // Turn 2 (sam) follows eleanor's message, which @mentions @sam.
    assert.equal(second!.role, "woken by @sam");
    // Turn 3 (eleanor) follows sam's message, which @mentions @eleanor.
    assert.equal(third!.role, "woken by @eleanor");
  });

  it("traces turn 1 and turn 2 to their real message/wake/turn ids with no recall", async () => {
    const model = await buildRunViewModel(GOLDEN_FIXTURE_DIR);
    const [, first, second] = model.thread;

    assert.equal(first!.trace?.inEventId, "moltnet:msg_99fc83b2-da39-437e-8d32-a0e3f1dd4a1b");
    assert.equal(
      first!.trace?.turnInputEventId,
      "daimon:moltnet:msg_99fc83b2-da39-437e-8d32-a0e3f1dd4a1b:turn.input.submitted"
    );
    assert.ok(first!.trace?.turnOutputEventId);
    assert.ok(first!.trace?.wakeEventId?.includes("wake-eleanor"));
    assert.deepEqual(first!.trace?.recalledMemoryEventIds, []);

    assert.equal(second!.agentId, "sam");
    assert.deepEqual(second!.trace?.recalledMemoryEventIds, []);
  });

  it("surfaces the turn-3 recall edge: turn.input caused by the message and two mneme: recall ids", async () => {
    const model = await buildRunViewModel(GOLDEN_FIXTURE_DIR);
    const third = model.thread[3];

    assert.equal(third!.turn, 3);
    assert.equal(third!.agentId, "eleanor");
    assert.ok(third!.trace, "expected turn 3 to resolve a causal trace");
    assert.equal(third!.trace!.recalledMemoryEventIds.length, 2);
    for (const memoryId of third!.trace!.recalledMemoryEventIds) {
      assert.match(memoryId, /^mneme:/);
    }
    assert.ok(third!.trace!.turnInputCauses.includes("moltnet:msg_13f51ee4-37f9-43f6-8399-23a95a27263c"));
  });

  it("builds a memory portal per agent from the mneme events.jsonl bank log", async () => {
    const model = await buildRunViewModel(GOLDEN_FIXTURE_DIR);
    assert.equal(model.minds.length, 2);

    const eleanor = model.minds.find((mind) => mind.agentId === "eleanor");
    const sam = model.minds.find((mind) => mind.agentId === "sam");
    assert.ok(eleanor);
    assert.ok(sam);
    assert.equal(eleanor!.eventCount, 8);
    assert.equal(sam!.eventCount, 2);
    assert.ok(eleanor!.rows.some((row) => row.stratum === "recalled"));
    assert.ok(eleanor!.rows.every((row) => row.sourceId.startsWith("evt_")));
  });

  it("carries every manifest artifact into provenance with its verified sha256", async () => {
    const model = await buildRunViewModel(GOLDEN_FIXTURE_DIR);
    assert.ok(model.provenance.artifacts.length >= 6);
    assert.ok(model.provenance.artifacts.every((artifact) => artifact.ok));
    const entry = model.provenance.entries.find((row) => row.key === "contract");
    assert.equal(entry?.value, "simfile.observe.v1");
  });

  it("omits variableSamples entirely for a run with no world variables (graceful absence, never a fabricated empty gauge)", async () => {
    const model = await buildRunViewModel(GOLDEN_FIXTURE_DIR);
    assert.equal(model.variableSamples, undefined);
  });
});

describe("buildRunViewModel — office-pressure-v0 golden fixture (variable storyline)", () => {
  const VARIABLE_GOLDEN_FIXTURE_DIR = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "fixtures",
    "observe",
    "office-pressure-v0-golden"
  );

  it("passes through world/telemetry.json's real, ramping filing_pressure samples", async () => {
    const model = await buildRunViewModel(VARIABLE_GOLDEN_FIXTURE_DIR);
    assert.ok(model.variableSamples);
    assert.equal(model.variableSamples!.length, 3);
    assert.deepEqual(
      model.variableSamples!.map((sample) => sample.variables.filing_pressure),
      [0.7, 1, 1],
    );
  });

  it("is healthy with no reconciliation failures despite the empty seed token_set (this fixture carries no doc-seeded secret)", async () => {
    const model = await buildRunViewModel(VARIABLE_GOLDEN_FIXTURE_DIR);
    assert.equal(model.verdict.healthy, true);
    assert.equal(model.verdict.failures, 0);
  });
});
