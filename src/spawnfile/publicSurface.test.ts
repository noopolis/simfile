import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { ensurePublicPackageBuild } from "../publicPackageBuild.test-helper.js";
import * as spawnfile from "./index.js";

const packageRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const tscPath = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc");
const execFileAsync = promisify(execFile);

const publicValues = [
  "assertSpawnfileAuthProfileName",
  "createSpawnfileComposedPreparationRequestDigest",
  "parseSpawnfileComposedPreparationReceipt",
  "parseSpawnfileComposedPreparationRequest",
  "parseSpawnfileDownReceipt",
  "parseSpawnfileExportResult",
  "parseSpawnfileUpReceipt",
  "runSpawnfileArtifactsExport",
  "runSpawnfileComposedPreparation",
  "runSpawnfileDown",
  "runSpawnfileUp",
  "verifySpawnfileComposedPreparationReceipt"
].sort();
const forbiddenRuntimeExport = new RegExp(["tiny", "Foot" + "ball", "foot" + "ball", "mol", "tnet", "poll", "client"].join("|"), "iu");

test("spawnfile public surface is the exact neutral external-consumer contract", async () => {
  assert.deepEqual(Object.keys(spawnfile).sort(), publicValues);
  for (const key of Object.keys(spawnfile)) {
    assert.doesNotMatch(key, forbiddenRuntimeExport);
  }

  const consumerRoot = await mkdtemp(path.join(tmpdir(), "simfile-spawnfile-consumer-"));
  try {
    await ensurePublicPackageBuild(packageRoot);
    await mkdir(path.join(consumerRoot, "node_modules"), { recursive: true });
    await symlink(packageRoot, path.join(consumerRoot, "node_modules", "simfile"), "dir");

    const sourcePath = path.join(consumerRoot, "consumer.mts");
    await writeFile(sourcePath, [
      'import { assertSpawnfileAuthProfileName, parseSpawnfileComposedPreparationRequest, parseSpawnfileExportResult } from "simfile/spawnfile";',
      'import type { RunSpawnfileArtifactsExportInput, RunSpawnfileComposedPreparationInput, RunSpawnfileDownInput, RunSpawnfileUpInput, SpawnfileCliContext, SpawnfileComposedPreparationReceipt, SpawnfileComposedPreparationRequest, SpawnfileDownReceipt, SpawnfileExportIndexFile, SpawnfileExportResult, SpawnfileUpReceipt } from "simfile/spawnfile";',
      'const digest = "a".repeat(64);',
      'const file: SpawnfileExportIndexFile = { path: "raw/events.jsonl", sha256: digest };',
      'const result: SpawnfileExportResult = parseSpawnfileExportResult({ deployment: "run", index_path: "/tmp/index.json", index: { version: "spawnfile.export-index.v1", run_id: "run", deployment: "run", exported_at: "2026-01-01T00:00:00.000Z", files: [file] } });',
      'const context: SpawnfileCliContext = { spawnfileBin: "spawnfile.mjs" };',
      'const up: RunSpawnfileUpInput = { orgPath: "org", containerName: "container", deploymentName: "run", compiledOutputDirectory: "compiled", descriptorDigest: `sha256:${digest}`, dockerContext: "target", envFile: "/tmp/env", imageTag: "organization:run", networkAttachmentHandle: "opaque_abcdefghijklmnop", organizationHandoffRunId: "run", selectedTargetReceiptDigest: `sha256:${digest}`, selectedTargetReceiptFile: "/tmp/target.json", worldBindingsFile: "/tmp/world.json" };',
      'const exported: RunSpawnfileArtifactsExportInput = { orgPath: "org", deploymentName: "run", compiledOutputDirectory: "compiled", destinationDirectory: "out" };',
      'const down: RunSpawnfileDownInput = { orgPath: "org", deploymentName: "run", compiledOutputDirectory: "compiled" };',
      'const upReceipt = undefined as unknown as SpawnfileUpReceipt;',
      'const downReceipt = undefined as unknown as SpawnfileDownReceipt;',
      'const preparationRequest = undefined as unknown as SpawnfileComposedPreparationRequest;',
      'const preparationInput = undefined as unknown as RunSpawnfileComposedPreparationInput;',
      'const preparationReceipt = undefined as unknown as SpawnfileComposedPreparationReceipt;',
      'void [context, up, exported, down, upReceipt, downReceipt, preparationRequest, preparationInput, preparationReceipt];',
      'void parseSpawnfileComposedPreparationRequest;',
      'assertSpawnfileAuthProfileName("safe-profile_1");',
      'if (result.index.files[0]?.sha256 !== digest) throw new Error("receipt parser changed");'
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
    assert.match(emitted, /from ["']simfile\/spawnfile["']/u);
    assert.doesNotMatch(emitted, /(?:RunSpawnfile|SpawnfileCliContext|Spawnfile(?:ComposedPreparation|Down|Export|Up)Receipt|SpawnfileExportIndexFile)/u);
    await execFileAsync(process.execPath, [emittedPath], { cwd: consumerRoot });

    const typesOnlyPath = path.join(consumerRoot, "types-only.mts");
    await writeFile(typesOnlyPath, [
      'import type { SpawnfileCliContext, SpawnfileExportResult } from "simfile/spawnfile";',
      'const context = undefined as unknown as SpawnfileCliContext;',
      'const result = undefined as unknown as SpawnfileExportResult;',
      'void [context, result];'
    ].join("\n"));
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
      typesOnlyPath
    ], { cwd: consumerRoot });
    assert.doesNotMatch(await readFile(path.join(outputDirectory, "types-only.mjs"), "utf8"), /simfile\/spawnfile/u);
    await assert.rejects(import(["simfile", "sims"].join("/")), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  } finally {
    await rm(consumerRoot, { force: true, recursive: true });
  }
});
