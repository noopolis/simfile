import assert from "node:assert/strict";
import { test } from "node:test";

import { adjudicateSummary, nodeTestArguments, parseTapSummary } from "./run-tests.mjs";

test("pins TAP before every requested test pattern", () => {
  assert.deepEqual(nodeTestArguments(["src/example.test.ts"]), [
    "--import", "tsx", "--test", "--test-reporter=tap", "src/example.test.ts",
  ]);
});

test("rejects a run with zero passed tests even when Node exits successfully", () => {
  const summary = parseTapSummary("# tests 0\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n");
  const verdict = adjudicateSummary(summary, 0);
  assert.equal(verdict.exitCode, 1);
  assert.match(verdict.message, /proved nothing/);
});

test("rejects cancelled tests and names their count", () => {
  const summary = parseTapSummary("# tests 13\n# pass 0\n# fail 0\n# cancelled 13\n# skipped 0\n");
  const verdict = adjudicateSummary(summary, 1);
  assert.equal(verdict.exitCode, 1);
  assert.match(verdict.message, /13 test\(s\) cancelled/);
});

test("allows a healthy passing run", () => {
  const summary = parseTapSummary("# tests 7\n# pass 7\n# fail 0\n# cancelled 0\n# skipped 0\n");
  assert.deepEqual(adjudicateSummary(summary, 0), { message: null, exitCode: 0 });
});
