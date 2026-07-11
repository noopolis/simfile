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
