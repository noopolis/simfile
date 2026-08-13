#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STELE = "@noopolis/stele";
const STELE_VERSION = "0.0.2";

const fail = (message) => {
  throw new Error(message);
};

const readJson = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));

const run = (command, args, cwd, env = process.env) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (code) => {
    if (code !== 0) {
      reject(new Error(`${command} ${args.join(" ")} failed (${code})\n${stderr}`));
      return;
    }
    resolve({ stderr, stdout });
  });
});

const parseSinglePack = (stdout) => {
  let parsed;
  for (let index = stdout.lastIndexOf("["); index >= 0; index = stdout.lastIndexOf("[", index - 1)) {
    try {
      const candidate = JSON.parse(stdout.slice(index));
      if (Array.isArray(candidate)) {
        parsed = candidate;
        break;
      }
    } catch {
      // Lifecycle scripts may write before npm's final JSON array.
    }
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    fail("npm pack must report exactly one tarball");
  }
  const [result] = parsed;
  if (!result || typeof result.filename !== "string" || !Array.isArray(result.files)) {
    fail("npm pack returned an invalid manifest");
  }
  return result;
};

const assertRegistrySource = async (manifest, lock) => {
  if (manifest.dependencies?.[STELE] !== STELE_VERSION) {
    fail(`${STELE} must use the published ${STELE_VERSION} release coordinate`);
  }
  if (manifest.bundledDependencies !== undefined || manifest.bundleDependencies !== undefined) {
    fail("published registry dependencies must not be bundled");
  }
  for (const [name, coordinate] of Object.entries(manifest.dependencies ?? {})) {
    if (typeof coordinate !== "string" || /^(?:file|link|workspace):/u.test(coordinate)) {
      fail(`runtime dependency ${name} is not a registry coordinate`);
    }
  }
  for (const [location, entry] of Object.entries(lock.packages ?? {})) {
    if (location === "") continue;
    if (entry?.link === true || (typeof entry?.resolved === "string" && /^(?:file|link):/u.test(entry.resolved))) {
      fail(`package lock contains a checkout-relative dependency at ${location}`);
    }
  }
  const locked = lock.packages?.[`node_modules/${STELE}`];
  const expected = `https://registry.npmjs.org/@noopolis/stele/-/stele-${STELE_VERSION}.tgz`;
  if (!locked || locked.version !== STELE_VERSION || locked.resolved !== expected) {
    fail(`${STELE} lock entry must resolve to the exact npm registry tarball`);
  }
  if (typeof locked.integrity !== "string" || !locked.integrity.startsWith("sha512-")) {
    fail(`${STELE} registry lock is missing sha512 integrity`);
  }
  const installed = path.join(packageRoot, "node_modules", STELE);
  if ((await lstat(installed)).isSymbolicLink()) {
    fail(`${STELE} must be physically installed; source-checkout links are rejected`);
  }
  if ((await readJson(path.join(installed, "package.json"))).version !== STELE_VERSION) {
    fail(`${STELE} installed version drifted`);
  }
  return expected;
};

const assertPackedManifest = (manifest) => {
  if (manifest.version !== "0.0.2") fail("packed Simfile version drifted");
  if (manifest.dependencies?.[STELE] !== STELE_VERSION) {
    fail(`packed ${STELE} coordinate drifted`);
  }
  if (manifest.bundledDependencies !== undefined || manifest.bundleDependencies !== undefined) {
    fail("packed manifest unexpectedly bundles registry dependencies");
  }
  for (const [name, coordinate] of Object.entries(manifest.dependencies ?? {})) {
    if (typeof coordinate === "string" && /^(?:file|link|workspace):/u.test(coordinate)) {
      fail(`packed dependency ${name} retains a checkout-relative coordinate`);
    }
  }
};

const dependencyRoot = async (installRoot, installedRoot) => {
  for (const candidate of [
    path.join(installedRoot, "node_modules", STELE),
    path.join(installRoot, "node_modules", STELE)
  ]) {
    try {
      await lstat(candidate);
      return candidate;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  fail(`${STELE} was not installed from the packed Simfile dependency graph`);
};

const assertInstalledClosure = async (installRoot, manifest, tarballPath) => {
  await writeFile(path.join(installRoot, "package.json"), "{\"private\":true}\n", "utf8");
  await run("npm", [
    "install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock",
    "--registry=https://registry.npmjs.org", tarballPath
  ], installRoot);
  const installedRoot = path.join(installRoot, "node_modules", manifest.name);
  if ((await lstat(installedRoot)).isSymbolicLink()) fail("Simfile installed as a source link");
  const simfile = await import(pathToFileURL(path.join(installedRoot, "dist/index.js")).href);
  if (typeof simfile.parseSimfileSource !== "function") fail("installed Simfile public import is incomplete");

  const steleRoot = await dependencyRoot(installRoot, installedRoot);
  if ((await lstat(steleRoot)).isSymbolicLink()) fail(`${STELE} installed as a source link`);
  const steleManifest = await readJson(path.join(steleRoot, "package.json"));
  if (steleManifest.version !== STELE_VERSION) fail(`${STELE} installed version drifted`);
  const steleImport = steleManifest.exports?.["."]?.import;
  if (typeof steleImport !== "string" || !steleImport.startsWith("./")) {
    fail(`${STELE} does not expose a package-relative ESM entrypoint`);
  }
  const installRealRoot = await realpath(installRoot);
  const steleRealPath = await realpath(path.resolve(steleRoot, steleImport));
  if (!steleRealPath.startsWith(`${installRealRoot}${path.sep}`)) {
    fail(`${STELE} resolved outside the isolated install`);
  }
  const stele = await import(pathToFileURL(steleRealPath).href);
  if (typeof stele.parseCausalJsonl !== "function") fail(`${STELE} runtime import is incomplete`);

  const executable = path.join(installRoot, "node_modules", ".bin", "simfile");
  const help = await run(executable, ["--help"], installRoot, {
    ...process.env,
    PATH: `${path.dirname(executable)}${path.delimiter}${process.env.PATH ?? ""}`
  });
  if (!help.stdout.startsWith("Usage:\n") || !help.stdout.includes("simfile run <path>")) {
    fail("installed Simfile executable did not invoke the CLI entrypoint");
  }
  const importProbe = path.join(installRoot, "import-cli.mjs");
  const installedCli = path.join(installedRoot, manifest.bin.simfile);
  await writeFile(importProbe, [
    `await import(${JSON.stringify(pathToFileURL(installedCli).href)});`,
    'process.stdout.write("import-only-ok\\n");',
    ""
  ].join("\n"), "utf8");
  const imported = await run(process.execPath, [importProbe], installRoot);
  if (imported.stdout !== "import-only-ok\n" || imported.stderr !== "") {
    fail("importing the installed CLI produced entrypoint side effects");
  }
  return path.relative(installRealRoot, steleRealPath);
};

const main = async () => {
  const manifest = await readJson(path.join(packageRoot, "package.json"));
  const lock = await readJson(path.join(packageRoot, "package-lock.json"));
  const steleRegistryTarball = await assertRegistrySource(manifest, lock);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "simfile-closure-"));
  try {
    const packDirectory = path.join(temporaryRoot, "pack");
    const installRoot = path.join(temporaryRoot, "install");
    await Promise.all([
      mkdir(packDirectory, { recursive: true }),
      mkdir(installRoot, { recursive: true })
    ]);
    const packed = parseSinglePack((await run(
      "npm", ["pack", "--json", "--pack-destination", packDirectory], packageRoot
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
    const packedManifest = JSON.parse((await run(
      "tar", ["-xOf", tarballPath, "package/package.json"], packageRoot
    )).stdout);
    assertPackedManifest(packedManifest);
    const steleResolved = await assertInstalledClosure(installRoot, manifest, tarballPath);
    process.stdout.write(`${JSON.stringify({
      bundled: packed.bundled ?? [],
      entries: packed.entryCount,
      integrity: packed.integrity,
      package: packed.id,
      packed_file: packed.filename,
      runtime_dependencies: packedManifest.dependencies,
      stele_registry_tarball: steleRegistryTarball,
      stele_resolved_inside_install: steleResolved
    }, null, 2)}\n`);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
};

await main();
