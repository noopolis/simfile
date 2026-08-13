import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { ensurePublicPackageBuild } from "../publicPackageBuild.test-helper.js";
import * as observe from "./index.js";

const packageRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const tscPath = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc");
const execFileAsync = promisify(execFile);

const publicValues = [
  "parseRunManifest",
  "RUN_MANIFEST_VERSION",
  "runObserve"
].sort();

const publicTypes = [
  "RunManifestArtifactEntry",
  "SimfileRunManifest"
].sort();

test("observe public surface is the exact neutral external-consumer contract", async () => {
  assert.deepEqual(Object.keys(observe).sort(), publicValues);
  const barrel = await readFile(path.join(packageRoot, "src", "observe", "index.ts"), "utf8");
  assert.deepEqual(
    [...barrel.matchAll(/type (RunManifestArtifactEntry|SimfileRunManifest)/gu)].map((match) => match[1]).sort(),
    publicTypes
  );
  assert.doesNotMatch(barrel, /(?:SeedDeclaration|OBSERVE_REPORT_VERSION|ObserveResult|parseObserveReport|writeObserveReport|collectCausalStreams)/u);

  const consumerRoot = await mkdtemp(path.join(tmpdir(), "simfile-observe-consumer-"));
  try {
    await ensurePublicPackageBuild(packageRoot);
    await mkdir(path.join(consumerRoot, "node_modules"), { recursive: true });
    await symlink(packageRoot, path.join(consumerRoot, "node_modules", "simfile"), "dir");

    const sourcePath = path.join(consumerRoot, "consumer.mts");
    await writeFile(sourcePath, [
      'import { RUN_MANIFEST_VERSION, parseRunManifest, runObserve } from "simfile/observe";',
      'import type { RunManifestArtifactEntry, SimfileRunManifest } from "simfile/observe";',
      'const artifact: RunManifestArtifactEntry = { path: "raw/events.jsonl", sha256: "a".repeat(64) };',
      'const manifest: SimfileRunManifest = parseRunManifest({ version: RUN_MANIFEST_VERSION, run_id: "run", created_at: "2026-01-01T00:00:00.000Z", contract_versions: {}, artifacts: [artifact] });',
      'if (RUN_MANIFEST_VERSION !== "simfile.run-manifest.v1") throw new Error("wrong manifest version");',
      'if (manifest.artifacts[0]?.path !== artifact.path) throw new Error("wrong artifact");',
      'if (typeof runObserve !== "function") throw new Error("missing observe function");'
    ].join("\n"));
    const outputDirectory = path.join(consumerRoot, "out");
    await execFileAsync(process.execPath, [
      tscPath,
      "--pretty", "false",
      "--target", "ES2023",
      "--module", "NodeNext",
      "--moduleResolution", "NodeNext",
      "--strict",
      "--skipLibCheck",
      "--rootDir", consumerRoot,
      "--outDir", outputDirectory,
      sourcePath
    ], { cwd: consumerRoot });
    const emittedPath = path.join(outputDirectory, "consumer.mjs");
    const emitted = await readFile(emittedPath, "utf8");
    assert.match(emitted, /(?:from|require\()\s*["']simfile\/observe["']/u);
    await execFileAsync(process.execPath, [emittedPath], { cwd: consumerRoot });
  } finally {
    await rm(consumerRoot, { force: true, recursive: true });
  }
});
