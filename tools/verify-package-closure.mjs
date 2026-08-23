#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertDevelopmentAssets,
  assertPackedManifest,
  assertRegistrySource,
  fail,
  parseSinglePack,
  readJson,
} from "./package-closure-contract.mjs";
import {
  assertInstalledClosure,
  buildPackedExample,
  runPackageClosureProcess,
} from "./package-closure-install.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const main = async () => {
  const manifest = await readJson(path.join(packageRoot, "package.json"));
  const lock = await readJson(path.join(packageRoot, "package-lock.json"));
  const steleRegistryTarball = await assertRegistrySource(packageRoot, manifest, lock);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "simfile-closure-"));
  try {
    const packDirectory = path.join(temporaryRoot, "pack");
    const installRoot = path.join(temporaryRoot, "install");
    await Promise.all([
      mkdir(packDirectory, { recursive: true }),
      mkdir(installRoot, { recursive: true }),
    ]);
    const packed = parseSinglePack((await runPackageClosureProcess(
      "npm", ["pack", "--json", "--pack-destination", packDirectory], packageRoot,
    )).stdout);
    const tarballPath = path.join(packDirectory, packed.filename);
    const packedBytes = await readFile(tarballPath);
    const integrity = `sha512-${createHash("sha512").update(packedBytes).digest("base64")}`;
    const shasum = createHash("sha1").update(packedBytes).digest("hex");
    if (packed.integrity !== integrity || packed.shasum !== shasum) {
      fail("npm pack manifest integrity does not match the tarball bytes");
    }
    const entries = packed.files.map((entry) => entry.path);
    if ((packed.bundled?.length ?? 0) !== 0) fail("npm pack unexpectedly bundled dependencies");
    if (entries.some((entry) => entry.startsWith("node_modules/")
      || entry.startsWith("fixtures/") || entry.startsWith("runs/")
      || entry.includes("ecosystem/") || entry.startsWith("vendor/"))) {
      fail("packed tarball leaked a fixture, dependency, source checkout, or vendor archive");
    }
    assertDevelopmentAssets(entries);
    const packedManifest = JSON.parse((await runPackageClosureProcess(
      "tar", ["-xOf", tarballPath, "package/package.json"], packageRoot,
    )).stdout);
    assertPackedManifest(packedManifest);
    const installed = await assertInstalledClosure(installRoot, manifest, tarballPath);
    const exampleBundleDigest = await buildPackedExample(temporaryRoot, tarballPath);
    process.stdout.write(`${JSON.stringify({
      bundled: packed.bundled ?? [], entries: packed.entryCount,
      integrity: packed.integrity, package: packed.id, packed_file: packed.filename,
      packed_example_bundle_digest: exampleBundleDigest,
      runtime_dependencies: packedManifest.dependencies,
      stele_registry_tarball: steleRegistryTarball,
      stele_resolved_inside_install: installed.steleResolved,
    }, null, 2)}\n`);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
};

await main();
