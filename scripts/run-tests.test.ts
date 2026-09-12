import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { adjudicateSummary, nodeTestArguments, parseTapSummary } from "./run-tests.ts";

test("pins TAP before every requested test pattern", () => {
  assert.deepEqual(nodeTestArguments(["src/example.test.ts"]), [
    "--import", "tsx", "--test", "--test-reporter=tap", "src/example.test.ts",
  ]);
});

test("default run includes maintained script tests", async () => {
  const { defaultTestArguments } = await import("./run-tests.ts");
  assert.equal(defaultTestArguments.includes("scripts/**/*.test.ts"), true);
});

test("rejects a run with zero passed tests even when Node exits successfully", () => {
  const summary = parseTapSummary("# tests 0\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n");
  const verdict = adjudicateSummary(summary, 0);
  assert.equal(verdict.exitCode, 1);
  assert.match(verdict.message ?? "", /proved nothing/);
});

test("rejects cancelled tests and names their count", () => {
  const summary = parseTapSummary("# tests 13\n# pass 0\n# fail 0\n# cancelled 13\n# skipped 0\n");
  const verdict = adjudicateSummary(summary, 1);
  assert.equal(verdict.exitCode, 1);
  assert.match(verdict.message ?? "", /13 test\(s\) cancelled/);
});

test("allows a healthy passing run", () => {
  const summary = parseTapSummary("# tests 7\n# pass 7\n# fail 0\n# cancelled 0\n# skipped 0\n");
  assert.deepEqual(adjudicateSummary(summary, 0), { message: null, exitCode: 0 });
});


test("CLI runner emits TAP from a path containing spaces", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "simfile runner path "));
  try {
    const runner = path.join(root, "runner with spaces.ts");
    await copyFile(new URL("./run-tests.ts", import.meta.url), runner);
    await copyFile(new URL("./entrypoint.ts", import.meta.url), path.join(root, "entrypoint.ts"));
    const sentinel = path.join(root, "sentinel.test.ts");
    await writeFile(sentinel, [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'test("encoded path runner sentinel", () => assert.equal(1, 1));',
      "",
    ].join("\n"), "utf8");

    const result = spawnSync(process.execPath, ["--experimental-strip-types", runner, sentinel], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        HOME: process.env.HOME ?? "",
        PATH: process.env.PATH ?? "",
        TMPDIR: process.env.TMPDIR ?? "",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /encoded path runner sentinel/u);
    assert.match(result.stdout, /# pass 1/u);
    assert.equal(result.stderr, "");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
