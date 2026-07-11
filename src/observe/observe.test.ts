import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runObserve } from "./observe.js";

const GOLDEN_FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "observe",
  "office-sim-golden"
);

const LEDGER_WRITES_FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "observe",
  "ledger-writes-synthetic"
);

/**
 * The seam-proving test (Slice B / Piece 2): `simfile observe` reads ONLY
 * files under the golden fixture (a real captured office-sim run — see
 * `fixtures/observe/office-sim-golden/manifest.json`) and reproduces the
 * exact verdict `src/e2e/officeSim.ts` computes inline from a live run
 * (both agents present, >= 3 turns, chain complete, >= 1 memory write and
 * >= 1 recall). Zero new Spawnfile code: this test only imports
 * `@noopolis/stele` (transitively, via `observe.js`) and this package's
 * own modules.
 */
describe("runObserve — office-sim golden fixture (monolith-verdict reproduction)", () => {
  it("verifies every manifest-declared artifact's sha256 against the real captured files", async () => {
    const result = await runObserve(GOLDEN_FIXTURE_DIR);
    assert.ok(result.artifactIntegrity.length > 0);
    for (const check of result.artifactIntegrity) {
      assert.equal(check.ok, true, `artifact ${check.path} failed integrity check`);
    }
  });

  it("parses every raw causal.jsonl stream with zero errors", async () => {
    const result = await runObserve(GOLDEN_FIXTURE_DIR);
    assert.deepEqual(result.causalParseErrors, []);
  });

  it("reports both eleanor and sam as participants", async () => {
    const result = await runObserve(GOLDEN_FIXTURE_DIR);
    assert.ok(result.report.participants.includes("eleanor"));
    assert.ok(result.report.participants.includes("sam"));
  });

  it("counts at least 3 agent turns, ordered by the moltnet message seq that triggered each", async () => {
    const result = await runObserve(GOLDEN_FIXTURE_DIR);
    assert.ok(result.report.agent_turns.count >= 3);
    assert.deepEqual(result.report.agent_turns.sequence, ["eleanor", "sam", "eleanor"]);
  });

  it("reconciles every causal chain complete (0 incomplete flags) — never stitched", async () => {
    const result = await runObserve(GOLDEN_FIXTURE_DIR);
    assert.deepEqual(result.report.chains.incomplete, []);
    assert.ok(result.report.chains.complete > 0);
  });

  it("counts at least one memory write and one recall for the office-recall bank", async () => {
    const result = await runObserve(GOLDEN_FIXTURE_DIR);
    const bank = result.report.memory.find((entry) => entry.bank === "office-recall");
    assert.ok(bank, "expected an office-recall memory bank entry");
    assert.ok(bank!.events >= 1);
    assert.ok(bank!.recalls >= 1);
  });

  it("marks the write count as events-fallback (this fixture predates memory.written)", async () => {
    const result = await runObserve(GOLDEN_FIXTURE_DIR);
    const bank = result.report.memory.find((entry) => entry.bank === "office-recall");
    assert.ok(bank, "expected an office-recall memory bank entry");
    assert.equal(bank!.memory_write_source, "events-fallback");
    assert.equal(bank!.writes_by_agent, undefined);
  });

  it("reports zero unclassified turn/wake failures", async () => {
    const result = await runObserve(GOLDEN_FIXTURE_DIR);
    assert.deepEqual(result.report.failures, []);
  });

  it("emits a simfile.observe.v1-shaped report with seed_spread/wake_diff omitted (office-sim has neither)", async () => {
    const result = await runObserve(GOLDEN_FIXTURE_DIR);
    assert.equal(result.report.version, "simfile.observe.v1");
    assert.equal(result.report.seed_spread, undefined);
    assert.equal(result.report.wake_diff, undefined);
  });
});

/**
 * Slice B Piece 4b: a hand-crafted fixture whose `raw/mneme/ledger-bank/`
 * carries BOTH a `memory.written`-bearing `causal.jsonl` (3 events: 2 from
 * agent:nora, 1 from agent:iris, each `cause_event_ids`-chained to the
 * `turn.output.completed` that produced it) AND a deliberately
 * different-count `events.jsonl` (6 lines) — so a count of exactly 3
 * (never 6) proves `simfile observe` read the ledger, not the fallback.
 */
describe("runObserve — ledger-writes synthetic fixture (Slice B Piece 4b)", () => {
  it("counts memory writes from the memory.written ledger, not the events.jsonl fallback", async () => {
    const result = await runObserve(LEDGER_WRITES_FIXTURE_DIR);
    const bank = result.report.memory.find((entry) => entry.bank === "ledger-bank");
    assert.ok(bank, "expected a ledger-bank memory bank entry");
    assert.equal(bank!.memory_write_source, "ledger");
    assert.equal(bank!.events, 3, "3 memory.written events, not events.jsonl's 6 lines");
    assert.deepEqual(bank!.writes_by_agent, { nora: 2, iris: 1 });
  });

  it("still reads recalls from events.jsonl's own memory.recalled lines", async () => {
    const result = await runObserve(LEDGER_WRITES_FIXTURE_DIR);
    const bank = result.report.memory.find((entry) => entry.bank === "ledger-bank");
    assert.ok(bank, "expected a ledger-bank memory bank entry");
    assert.equal(bank!.recalls, 2);
  });

  it("reconciles every memory.written event's chain back to its turn as complete — never stitched", async () => {
    const result = await runObserve(LEDGER_WRITES_FIXTURE_DIR);
    assert.equal(result.report.chains.incomplete.length, 0);
    const writeEventIds = [
      "mneme:11111111-1111-4111-8111-111111111111",
      "mneme:22222222-2222-4222-8222-222222222222",
      "mneme:33333333-3333-4333-8333-333333333333"
    ];
    for (const eventId of writeEventIds) {
      assert.ok(
        result.report.chains.incomplete.every((entry) => entry.event_id !== eventId),
        `expected ${eventId} to reconcile complete, not flagged incomplete`
      );
    }
  });
});
