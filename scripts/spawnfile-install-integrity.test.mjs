import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { assertInstalledArtifact, hash } from "./spawnfile-install-integrity.mjs";

test("installed Spawnfile artifact verification rejects a tampered tarball", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "simfile-install-integrity-"));
  const executable = path.join(root, "node_modules", ".bin", "spawnfile");
  const tarball = path.join(root, "spawnfile.tgz");
  await mkdir(path.dirname(executable), { recursive: true });
  await mkdir(path.join(root, "node_modules", "spawnfile"), { recursive: true });
  await Promise.all([
    writeFile(executable, "#!/bin/sh\nexit 0\n"),
    writeFile(tarball, "trusted tarball\n"),
    writeFile(path.join(root, "node_modules", "spawnfile", "package.json"),
      '{"name":"spawnfile","version":"1.2.3"}\n'),
  ]);
  await chmod(executable, 0o755);
  const expected = {
    executable_sha256: hash(await readFile(executable)),
    package_version: "1.2.3",
    tarball_sha256: hash("trusted tarball\n"),
  };
  try {
    const installed = await assertInstalledArtifact(root, expected);
    const pinned = { ...expected, installed_closure_sha256: installed.installed_closure_sha256 };
    await writeFile(path.join(root, "node_modules", "spawnfile", "runtime.mjs"), "export {};\n");
    await assert.rejects(assertInstalledArtifact(root, pinned), /module closure drifted/u);
    await rm(path.join(root, "node_modules", "spawnfile", "runtime.mjs"));
    await writeFile(tarball, "tampered tarball\n");
    await assert.rejects(assertInstalledArtifact(root, pinned), /tarball digest drifted/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
