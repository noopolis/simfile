import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const maintainedSourceDirectories = ["scripts", "tools"] as const;
const forbiddenMaintainedSource = /\.(?:mjs|js)$/u;

export const maintainedJavaScriptSourceViolations = (entries: readonly string[]): string[] =>
  entries.filter((entry) => forbiddenMaintainedSource.test(entry)).sort();

const topLevelFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.posix.join(directory, entry.name));
};

test("maintained scripts and tools have no JavaScript source files", async () => {
  const entries = (await Promise.all(maintainedSourceDirectories.map(topLevelFiles))).flat();
  assert.deepEqual(maintainedJavaScriptSourceViolations(entries), []);
});

test("source policy catches a maintained JavaScript mutation", () => {
  assert.deepEqual(maintainedJavaScriptSourceViolations([
    "scripts/spawnfile-development.mjs",
    "tools/verify-package-closure.js",
  ]), [
    "scripts/spawnfile-development.mjs",
    "tools/verify-package-closure.js",
  ]);
});
