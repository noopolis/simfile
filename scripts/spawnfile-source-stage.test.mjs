import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { stagePhysicalSpawnfileSource } from "./spawnfile-source-stage.mjs";

test("source staging copies a physical checkout without its dependency or runtime state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "simfile-source-stage-"));
  const source = path.join(root, "source");
  const temporaryRoot = path.join(root, "temporary");
  await Promise.all([
    mkdir(path.join(source, "node_modules", "ignored"), { recursive: true }),
    mkdir(path.join(source, ".spawn", "ignored"), { recursive: true }),
    mkdir(path.join(source, "dist"), { recursive: true }),
    mkdir(temporaryRoot),
  ]);
  await Promise.all([
    writeFile(path.join(source, "package.json"), '{"name":"spawnfile","version":"1.2.3"}\n'),
    writeFile(path.join(source, "kept.txt"), "kept\n"),
    writeFile(path.join(source, "node_modules", "ignored", "state"), "ignored\n"),
    writeFile(path.join(source, ".spawn", "ignored", "state"), "ignored\n"),
    writeFile(path.join(source, "dist", "generated"), "ignored\n"),
  ]);
  try {
    const staged = await stagePhysicalSpawnfileSource(source, temporaryRoot);
    assert.deepEqual(staged.origin, { package_version: "1.2.3", path: await realpath(source) });
    assert.equal(await readFile(path.join(staged.staging, "kept.txt"), "utf8"), "kept\n");
    await assert.rejects(access(path.join(staged.staging, "node_modules")));
    await assert.rejects(access(path.join(staged.staging, ".spawn")));
    await assert.rejects(access(path.join(staged.staging, "dist")));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
