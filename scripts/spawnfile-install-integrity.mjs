import { createHash } from "node:crypto";
import { chmod, lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";

import { inspectPhysicalSpawnfileSource } from "./spawnfile-source-stage.mjs";

const fail = (message) => { throw new Error(message); };

export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const executableAt = (root) => path.join(root, "node_modules", ".bin", "spawnfile");
export const packagedTarballAt = (root) => path.join(root, "spawnfile.tgz");
export const probeIdentity = (probe) => Object.freeze({
  sha256: hash(JSON.stringify(probe)),
  version: probe.version,
});

export const installedClosureHash = async (installRoot) => {
  const closureRoot = path.join(installRoot, "node_modules");
  const digest = createHash("sha256");
  const visit = async (directory, relativeRoot = "") => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const relative = path.posix.join(relativeRoot, entry.name);
      const absolute = path.join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        digest.update(`L\0${relative}\0${await readlink(absolute)}\0`);
      } else if (info.isDirectory()) {
        digest.update(`D\0${relative}\0`);
        await visit(absolute, relative);
      } else if (info.isFile()) {
        digest.update(`F\0${relative}\0${info.mode & 0o777}\0${info.size}\0`);
        digest.update(await readFile(absolute));
        digest.update("\0");
      } else return fail("Installed Spawnfile closure contains an unsupported entry");
    }
  };
  await visit(closureRoot);
  return digest.digest("hex");
};

const installedPackage = async (installRoot) => {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(installRoot, "node_modules", "spawnfile", "package.json"), "utf8"));
  } catch (error) {
    return fail(`Unable to read installed Spawnfile metadata: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest?.name !== "spawnfile" || typeof manifest.version !== "string") {
    return fail("Installed Spawnfile package metadata is invalid");
  }
  return manifest;
};

const installedExecutable = async (installRoot, repairPermissions = false) => {
  const executable = executableAt(installRoot);
  const target = await realpath(executable).catch(() => fail("Installed Spawnfile executable is missing"));
  const physicalRoot = await realpath(installRoot);
  if (target !== physicalRoot && !target.startsWith(`${physicalRoot}${path.sep}`)) {
    return fail("Installed Spawnfile executable escaped its isolated tool root");
  }
  const info = await lstat(target);
  if (!info.isFile()) return fail("Installed Spawnfile executable is not a regular file");
  if (repairPermissions) await chmod(target, info.mode | 0o100);
  return { executable, target };
};

export const assertInstalledArtifact = async (installRoot, expected) => {
  const tarball = packagedTarballAt(installRoot);
  const tarballInfo = await lstat(tarball).catch(() => fail("Installed Spawnfile tarball is missing"));
  if (!tarballInfo.isFile() || tarballInfo.isSymbolicLink()) {
    return fail("Installed Spawnfile tarball is not a regular file");
  }
  const tarball_sha256 = hash(await readFile(tarball));
  if (expected.tarball_sha256 !== undefined && tarball_sha256 !== expected.tarball_sha256) {
    return fail("Installed Spawnfile tarball digest drifted; rerun dev:spawnfile:setup");
  }
  const manifest = await installedPackage(installRoot);
  if (expected.package_version !== undefined && manifest.version !== expected.package_version) {
    return fail("Installed Spawnfile package version drifted; rerun dev:spawnfile:setup");
  }
  const executable = await installedExecutable(installRoot, expected.repair_permissions === true);
  const executable_sha256 = hash(await readFile(executable.target));
  if (expected.executable_sha256 !== undefined && executable_sha256 !== expected.executable_sha256) {
    return fail("Installed Spawnfile executable digest drifted; rerun dev:spawnfile:setup");
  }
  const installed_closure_sha256 = await installedClosureHash(installRoot);
  if (expected.installed_closure_sha256 !== undefined
    && installed_closure_sha256 !== expected.installed_closure_sha256) {
    return fail("Installed Spawnfile module closure drifted; rerun dev:spawnfile:setup");
  }
  return Object.freeze({
    executable: executable.executable,
    executable_sha256,
    installed_closure_sha256,
    package_version: manifest.version,
    tarball_sha256,
  });
};

export const assertOrigin = async (origin) => {
  if (origin?.kind === "artifact" && typeof origin.path === "string"
    && path.isAbsolute(origin.path) && path.normalize(origin.path) === origin.path
    && /^[0-9a-f]{64}$/u.test(origin.sha256 ?? "")
    && typeof origin.package_version === "string") {
    const info = await lstat(origin.path).catch(() => fail("Spawnfile artifact origin is missing"));
    if (!info.isFile() || info.isSymbolicLink()) return fail("Spawnfile artifact origin is invalid");
    if (hash(await readFile(origin.path)) === origin.sha256) return;
    return fail("Spawnfile artifact origin digest changed; rerun dev:spawnfile:setup");
  }
  if (origin?.kind === "registry" && typeof origin.spec === "string"
    && /^spawnfile@[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(origin.spec)
    && typeof origin.package_version === "string") return;
  if (origin?.kind === "source" && typeof origin.path === "string"
    && typeof origin.package_version === "string") {
    const current = await inspectPhysicalSpawnfileSource(origin.path);
    if (current.package_version === origin.package_version) return;
    return fail("Spawnfile source origin version changed; rerun dev:spawnfile:setup");
  }
  return fail("Spawnfile development origin is invalid; rerun dev:spawnfile:setup");
};
