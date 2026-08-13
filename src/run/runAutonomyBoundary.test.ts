import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runRoot = fileURLToPath(new URL("./", import.meta.url));

const collectProductionFiles = async (root: string): Promise<string[]> => {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".ts")
        && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".test-helper.ts")) files.push(entryPath);
    }
  };
  await visit(path.resolve(root));
  return files.sort();
};

export const findRunAutonomyViolations = (sources: ReadonlyMap<string, string>): string[] => {
  const violations: string[] = [];
  for (const [file, source] of sources) {
    const name = path.basename(file);
    if (/\bscheduler\b|\bbarrier\b|\bretry(?:Loop|Count|Limit)\b|\bretry\s*\(/iu.test(source)) violations.push(`${name}: scheduler/barrier/retry construct`);
    if (/(?:src[\\/]e2e|\.\.[\\/]e2e)/u.test(source)) violations.push(`${name}: e2e harness reference`);
    if (/\bqueueController\s*\(/u.test(source)) violations.push(`${name}: queueController production call`);
  }
  return violations;
};

test("run-path autonomy ratchet is non-vacuous and rejects planted constructs", async () => {
  const files = await collectProductionFiles(runRoot);
  assert.ok(files.length > 0);
  assert.equal(files.every((file) => file.startsWith(path.resolve(runRoot) + path.sep)), true);
  const planted = new Map([[path.join(runRoot, "hostile.ts"), "const scheduler = true; const barrier = true; const retryLoop = true; import '../e2e/harness.js'; context.queueController(action);"]]);
  assert.notDeepEqual(findRunAutonomyViolations(planted), []);
  assert.deepEqual(findRunAutonomyViolations(new Map([[path.join(runRoot, "clean.ts"), "export const tick = 1;"]])), []);
  const sources = new Map(await Promise.all(files.map(async (file) => [file, await readFile(file, "utf8")] as const)));
  assert.deepEqual(findRunAutonomyViolations(sources), []);
});
