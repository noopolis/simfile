import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertLinkedSpawnfileSourceUnchanged,
  readLinkedSpawnfileSource,
  withUnchangedLinkedSpawnfileSource,
} from "./composedProjectPreflight.js";

test("linked Spawnfile preflight retains bytes and detects ordinary source drift through symlinks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simfile-source-preflight-"));
  try {
    const source = path.join(root, "Spawnfile");
    const linked = path.join(root, "Spawnfile-link");
    await writeFile(source, "organization: one\n");
    await symlink("Spawnfile", linked);
    const retained = await readLinkedSpawnfileSource(linked);
    await assertLinkedSpawnfileSourceUnchanged(retained);
    await writeFile(source, "organization: two\n");
    await assert.rejects(assertLinkedSpawnfileSourceUnchanged(retained),
      /linked Spawnfile source changed during composed bootstrap/u);
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("linked Spawnfile source guard detects drift from preparation and compile operations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simfile-source-operation-"));
  try {
    const source = path.join(root, "Spawnfile");
    await writeFile(source, "organization: one\n");
    const preparationSource = await readLinkedSpawnfileSource(source);
    await assert.rejects(withUnchangedLinkedSpawnfileSource(preparationSource, async () => {
      await writeFile(source, "organization: preparation\n");
    }), /linked Spawnfile source changed during composed bootstrap/u);

    const compileSource = await readLinkedSpawnfileSource(source);
    await assert.rejects(withUnchangedLinkedSpawnfileSource(compileSource, async () => {
      await writeFile(source, "organization: compile\n");
      throw new Error("compile failed");
    }), /linked Spawnfile source changed during composed bootstrap/u);
  } finally { await rm(root, { force: true, recursive: true }); }
});
