import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildReceiptLock } from "./buildReceiptLock.js";
import {
  parseLockAuthorityBytes,
  resolveToolchainAuthorityFromAnchor,
  type DynamicsReceiptLockToolchainAuthority
} from "./buildReceiptLockAuthority.js";
import {
  resolvePackageDescriptor,
  resolveProjectAuthority
} from "./buildReceiptLockFiles.js";
import {
  createLockFile,
  createSimfile,
  createSymlinkDirectory,
  readFileDigest,
  withTemp,
  writeJson
} from "./buildReceiptLock.test-helper.js";

const ESBUILD_VERSION = "0.28.1";
const TYPESCRIPT_VERSION = "5.9.3";

const toolchainAuthority = (): Promise<DynamicsReceiptLockToolchainAuthority> =>
  resolveToolchainAuthorityFromAnchor(fileURLToPath(import.meta.url), ESBUILD_VERSION, TYPESCRIPT_VERSION);

const strictBytes = (entries: Record<string, unknown>): readonly [Uint8Array, Uint8Array] => {
  const packageRaw = new TextEncoder().encode(JSON.stringify({ name: "simfile", version: "0.0.1" }));
  const lockRaw = new TextEncoder().encode(JSON.stringify({
    name: "simfile",
    version: "0.0.1",
    lockfileVersion: 3,
    packages: {
      "": { name: "simfile", version: "0.0.1" },
      ...entries
    }
  }));
  return [packageRaw, lockRaw];
};

const writeSelfLinkProject = async (
  project: string,
  authority: DynamicsReceiptLockToolchainAuthority,
  mutateEntries?: (entries: Array<{
    path: string;
    version?: string;
    name?: string;
    resolved?: string;
    link?: boolean;
  }>, resolved: string) => void,
  installedTarget = authority.absoluteRoot
): Promise<{ simfile: string; resolved: string }> => {
  const simfile = await createSimfile(project);
  const resolved = path.relative(project, authority.absoluteRoot).split(path.sep).join("/");
  await writeJson(path.join(project, "package.json"), {
    name: "project",
    version: "1.0.0",
    dependencies: { simfile: `file:${resolved}` }
  });
  const entries = [
    { path: resolved, version: authority.root_package_version },
    { path: "node_modules/simfile", resolved, link: true }
  ];
  mutateEntries?.(entries, resolved);
  await createLockFile(project, "project", "1.0.0", entries, {
    dependencies: { simfile: `file:${resolved}` }
  });
  await createSymlinkDirectory(installedTarget, path.join(project, "node_modules", "simfile"));
  return { simfile, resolved };
};

test("strict toolchain parser rejects links and traversal entries", () => {
  const [linkPackage, linkLock] = strictBytes({
    "node_modules/simfile": { resolved: "../../..", link: true }
  });
  assert.throws(
    () => parseLockAuthorityBytes("/strict", linkPackage, linkLock),
    /workspace lock entry rejected: node_modules\/simfile/
  );

  const [sourcePackage, sourceLock] = strictBytes({
    "../../..": { version: "0.0.1" }
  });
  assert.throws(
    () => parseLockAuthorityBytes("/strict", sourcePackage, sourceLock),
    /lock entry \.\.\/\.\.\/\.\.: unsafe path/
  );
});

test("project parser accepts exactly one bound Simfile self-link pair", async () => {
  await withTemp(async (root) => {
    const authority = await toolchainAuthority();
    const project = path.join(root, "project");
    const { simfile, resolved } = await writeSelfLinkProject(project, authority);
    const projectAuthority = await resolveProjectAuthority(project, authority);
    assert.ok(projectAuthority);
    assert.equal(projectAuthority.packageEntries.some((entry) =>
      entry.path === resolved || entry.path === "node_modules/simfile"
    ), false);
    assert.deepEqual(projectAuthority.selfLinkEntries, [{
      manager: "npm",
      lockfile_version: 3,
      lock_sha256: await readFileDigest(path.join(project, "package-lock.json")),
      lock_entry_path: "node_modules/simfile",
      package_name: "simfile",
      package_version: authority.root_package_version,
      package_manifest_sha256: authority.root_package_sha256,
      target: "toolchain_authority_root"
    }]);
    assert.equal(Object.isFrozen(projectAuthority.selfLinkEntries), true);
    assert.equal(Object.isFrozen(projectAuthority.selfLinkEntries[0]), true);

    const result = await buildReceiptLock(simfile, [], ESBUILD_VERSION, TYPESCRIPT_VERSION);
    assert.deepEqual(result.selfLinkEntries, projectAuthority.selfLinkEntries);
    const serialized = JSON.stringify(result.selfLinkEntries);
    assert.equal(serialized.includes(resolved), false);
    assert.equal(serialized.includes(authority.absoluteRoot), false);

    const sourceSha256 = await readFileDigest(path.join(authority.absoluteRoot, "package.json"));
    await assert.rejects(
      () => resolvePackageDescriptor({
        kind: "package",
        manifest_sha256: authority.root_package_sha256,
        modes: ["runtime"],
        package_name: "simfile",
        package_path: "./package.json",
        package_version: authority.root_package_version,
        sha256: sourceSha256
      }, [projectAuthority]),
      /missing package lock evidence: simfile/
    );
  });
});

test("project self-link rejects a target outside the toolchain authority", async () => {
  await withTemp(async (root) => {
    const authority = await toolchainAuthority();
    const other = path.join(root, "other");
    await mkdir(other);
    const installedMismatch = path.join(root, "installed-mismatch");
    await writeSelfLinkProject(installedMismatch, authority, undefined, other);
    await assert.rejects(
      () => resolveProjectAuthority(installedMismatch, authority),
      /Simfile self-link target authority mismatch/
    );

    const sourceMismatch = path.join(root, "source-mismatch");
    await createSimfile(sourceMismatch);
    const resolved = "../other";
    await writeJson(path.join(sourceMismatch, "package.json"), {
      name: "project",
      version: "1.0.0",
      dependencies: { simfile: `file:${resolved}` }
    });
    await createLockFile(sourceMismatch, "project", "1.0.0", [
      { path: resolved, version: authority.root_package_version },
      { path: "node_modules/simfile", resolved, link: true }
    ], { dependencies: { simfile: `file:${resolved}` } });
    await createSymlinkDirectory(authority.absoluteRoot, path.join(sourceMismatch, "node_modules", "simfile"));
    await assert.rejects(
      () => resolveProjectAuthority(sourceMismatch, authority),
      /Simfile self-link target authority mismatch/
    );
  });
});

test("project self-link rejects extra, unpaired, absolute, and malformed records", async () => {
  const authority = await toolchainAuthority();
  await withTemp(async (root) => {
    const extraProject = path.join(root, "extra");
    await writeSelfLinkProject(extraProject, authority, (entries) => {
      entries.push({ path: "node_modules/other", resolved: "../other", link: true });
    });
    await assert.rejects(
      () => resolveProjectAuthority(extraProject, authority),
      /invalid Simfile self-link entry/
    );

    const unpairedProject = path.join(root, "unpaired");
    await createSimfile(unpairedProject);
    await writeJson(path.join(unpairedProject, "package.json"), { name: "project", version: "1.0.0" });
    await createLockFile(unpairedProject, "project", "1.0.0", [{ path: "../../..", version: "0.0.1" }]);
    await assert.rejects(
      () => resolveProjectAuthority(unpairedProject, authority),
      /invalid Simfile self-link entry/
    );

    for (const [index, target] of [
      "/absolute/simfile",
      "https://example.invalid/simfile",
      "..\\..\\simfile",
      "../../simfile?query",
      "../../simfile#fragment",
      `../simfile${String.fromCodePoint(0x7f)}`
    ].entries()) {
      const project = path.join(root, `malformed-${index}`);
      await createSimfile(project);
      await writeJson(path.join(project, "package.json"), {
        name: "project",
        version: "1.0.0",
        dependencies: { simfile: `file:${target}` }
      });
      await createLockFile(project, "project", "1.0.0", [
        { path: target, version: authority.root_package_version },
        { path: "node_modules/simfile", resolved: target, link: true }
      ], { dependencies: { simfile: `file:${target}` } });
      await assert.rejects(
        () => resolveProjectAuthority(project, authority),
        /invalid Simfile self-link target/
      );
    }
  });
});

test("root lock stays strict and retains one integrity-pinned Stele package", async () => {
  const lock = JSON.parse(await readFile(path.join(process.cwd(), "package-lock.json"), "utf8")) as {
    packages: Record<string, { link?: boolean; integrity?: string }>;
  };
  const entries = Object.entries(lock.packages);
  assert.equal(entries.some(([entryPath, entry]) =>
    (entryPath !== "" && !entryPath.startsWith("node_modules/")) || entry.link === true
  ), false);
  const steleEntries = entries.filter(([entryPath]) => entryPath === "node_modules/@noopolis/stele");
  assert.equal(steleEntries.length, 1);
  assert.equal(typeof steleEntries[0]?.[1].integrity, "string");
});
