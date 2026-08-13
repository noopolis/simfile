import assert from "node:assert/strict";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { coalesceAuthoritiesByLockRealpath } from "./buildReceiptLock.js";
import {
  resolvePackageDescriptor,
  resolveProjectAuthority,
  buildTypeOnlyClaim
} from "./buildReceiptLockFiles.js";
import { resolveToolchainAuthorityFromAnchor } from "./buildReceiptLockAuthority.js";
import {
  createLockFile,
  createPackageManifest,
  createSimfile,
  withTemp,
  writeJson,
  writeSourceFile
} from "./buildReceiptLock.test-helper.js";
import { assertPortablePath } from "./buildReceiptLockPath.js";

const TOOLCHAIN_ESBUILD_VERSION = "0.28.1";
const TOOLCHAIN_TYPESCRIPT_VERSION = "5.9.3";
const TOOLCHAIN_NAME = "simfile";
const TOOLCHAIN_VERSION = "0.0.1";

const createSimpleToolPackage = async (root: string, name: string, version: string): Promise<void> => {
  await createPackageManifest(root, name, version, { main: "index.js" });
  await writeSourceFile(path.join(root, "index.js"), `exports.name = ${JSON.stringify(name)};\n`);
};

const resolveProjectAuthorityForTest = async (project: string) => resolveProjectAuthority(
  project,
  await resolveToolchainAuthorityFromAnchor(
    fileURLToPath(import.meta.url),
    TOOLCHAIN_ESBUILD_VERSION,
    TOOLCHAIN_TYPESCRIPT_VERSION
  )
);

test("project lock parse rejects malformed root lock data", async () => {
  await withTemp(async (root) => {
    const project = path.join(root, "project");
    await createSimfile(project);
    await writeJson(path.join(project, "package.json"), { name: "project", version: "1.0.0" });
    await writeJson(path.join(project, "package-lock.json"), {
      name: "project",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {}
    });

    await assert.rejects(
      () => resolveProjectAuthorityForTest(project),
      /invalid package-lock packages entry/
    );
  });
});

test("project lock dependency drift is surfaced", async () => {
  await withTemp(async (root) => {
    const project = path.join(root, "project");
    await createSimfile(project);
    await writeJson(path.join(project, "package.json"), {
      name: "project",
      version: "1.0.0",
      dependencies: { fixture: "1.2.3" }
    });
    await writeJson(path.join(project, "package-lock.json"), {
      name: "project",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "project",
          version: "1.0.0",
          dependencies: {}
        }
      }
    });

    await assert.rejects(
      () => resolveProjectAuthorityForTest(project),
      /lock root dependency drift: dependencies/
    );
  });
});

test("toolchain authority rejects stale nearer lock instead of falling through", async () => {
  await withTemp(async (root) => {
    const toolchainRoot = path.join(root, "toolchain");
    const anchor = path.join(toolchainRoot, "probe.js");
    await createSimfile(toolchainRoot);
    await writeFile(anchor, "", "utf8");

    await createSimpleToolPackage(path.join(toolchainRoot, "node_modules", "esbuild"), "esbuild", TOOLCHAIN_ESBUILD_VERSION);
    await createSimpleToolPackage(path.join(toolchainRoot, "node_modules", "typescript"), "typescript", TOOLCHAIN_TYPESCRIPT_VERSION);

    await writeJson(path.join(toolchainRoot, "node_modules", "package.json"), {
      name: TOOLCHAIN_NAME,
      version: TOOLCHAIN_VERSION,
      dependencies: {
        esbuild: TOOLCHAIN_ESBUILD_VERSION,
        typescript: TOOLCHAIN_TYPESCRIPT_VERSION
      }
    });
    await createLockFile(path.join(toolchainRoot, "node_modules"), TOOLCHAIN_NAME, TOOLCHAIN_VERSION, [
      { path: "node_modules/esbuild", version: TOOLCHAIN_ESBUILD_VERSION },
      { path: "node_modules/typescript", version: TOOLCHAIN_TYPESCRIPT_VERSION }
    ], {
      dependencies: {
        esbuild: TOOLCHAIN_ESBUILD_VERSION,
        typescript: TOOLCHAIN_TYPESCRIPT_VERSION
      }
    });

    await writeJson(path.join(toolchainRoot, "package.json"), {
      name: TOOLCHAIN_NAME,
      version: TOOLCHAIN_VERSION,
      dependencies: {
        esbuild: TOOLCHAIN_ESBUILD_VERSION,
        typescript: TOOLCHAIN_TYPESCRIPT_VERSION
      }
    });
    await createLockFile(toolchainRoot, TOOLCHAIN_NAME, TOOLCHAIN_VERSION, [
      { path: "node_modules/esbuild", version: TOOLCHAIN_ESBUILD_VERSION },
      { path: "node_modules/typescript", version: TOOLCHAIN_TYPESCRIPT_VERSION }
    ], {
      dependencies: {
        esbuild: TOOLCHAIN_ESBUILD_VERSION,
        typescript: TOOLCHAIN_TYPESCRIPT_VERSION
      }
    });

    await assert.rejects(
      () => resolveToolchainAuthorityFromAnchor(anchor, TOOLCHAIN_ESBUILD_VERSION, TOOLCHAIN_TYPESCRIPT_VERSION),
      /toolchain lock entry mismatch/
    );
  });
});

test("toolchain authority rejects a selected Simfile root with a missing lock", async () => {
  await withTemp(async (root) => {
    const toolchainRoot = path.join(root, "toolchain");
    const anchor = path.join(toolchainRoot, "probe.js");
    await createSimfile(toolchainRoot);
    await writeFile(anchor, "", "utf8");
    await writeJson(path.join(toolchainRoot, "package.json"), {
      name: TOOLCHAIN_NAME,
      version: TOOLCHAIN_VERSION,
      dependencies: {
        esbuild: TOOLCHAIN_ESBUILD_VERSION,
        typescript: TOOLCHAIN_TYPESCRIPT_VERSION
      }
    });
    await createSimpleToolPackage(path.join(toolchainRoot, "node_modules", "esbuild"), "esbuild", TOOLCHAIN_ESBUILD_VERSION);
    await createSimpleToolPackage(path.join(toolchainRoot, "node_modules", "typescript"), "typescript", TOOLCHAIN_TYPESCRIPT_VERSION);
    await createLockFile(toolchainRoot, TOOLCHAIN_NAME, TOOLCHAIN_VERSION, [
      { path: "node_modules/esbuild", version: TOOLCHAIN_ESBUILD_VERSION },
      { path: "node_modules/typescript", version: TOOLCHAIN_TYPESCRIPT_VERSION }
    ], {
      dependencies: {
        esbuild: TOOLCHAIN_ESBUILD_VERSION,
        typescript: TOOLCHAIN_TYPESCRIPT_VERSION
      }
    });
    await writeJson(path.join(toolchainRoot, "node_modules", "package.json"), {
      name: TOOLCHAIN_NAME,
      version: TOOLCHAIN_VERSION
    });

    await assert.rejects(
      () => resolveToolchainAuthorityFromAnchor(anchor, TOOLCHAIN_ESBUILD_VERSION, TOOLCHAIN_TYPESCRIPT_VERSION),
      /partial toolchain authority/
    );
  });
});

test("toolchain authority rejects an explicit mismatched tool entry name", async () => {
  await withTemp(async (root) => {
    const toolchainRoot = path.join(root, "toolchain");
    const anchor = path.join(toolchainRoot, "probe.js");
    await createSimfile(toolchainRoot);
    await writeFile(anchor, "", "utf8");
    await writeJson(path.join(toolchainRoot, "package.json"), {
      name: TOOLCHAIN_NAME,
      version: TOOLCHAIN_VERSION,
      dependencies: {
        esbuild: TOOLCHAIN_ESBUILD_VERSION,
        typescript: TOOLCHAIN_TYPESCRIPT_VERSION
      }
    });
    await createSimpleToolPackage(path.join(toolchainRoot, "node_modules", "esbuild"), "esbuild", TOOLCHAIN_ESBUILD_VERSION);
    await createSimpleToolPackage(path.join(toolchainRoot, "node_modules", "typescript"), "typescript", TOOLCHAIN_TYPESCRIPT_VERSION);
    await createLockFile(toolchainRoot, TOOLCHAIN_NAME, TOOLCHAIN_VERSION, [
      { path: "node_modules/esbuild", version: TOOLCHAIN_ESBUILD_VERSION, name: "not-esbuild" },
      { path: "node_modules/typescript", version: TOOLCHAIN_TYPESCRIPT_VERSION }
    ], {
      dependencies: {
        esbuild: TOOLCHAIN_ESBUILD_VERSION,
        typescript: TOOLCHAIN_TYPESCRIPT_VERSION
      }
    });

    await assert.rejects(
      () => resolveToolchainAuthorityFromAnchor(anchor, TOOLCHAIN_ESBUILD_VERSION, TOOLCHAIN_TYPESCRIPT_VERSION),
      /toolchain lock entry name mismatch: esbuild/
    );
  });
});

test("alias lock entry names are respected for package-name resolution", async () => {
  await withTemp(async (root) => {
    const project = path.join(root, "project");
    await createSimfile(project);
    await writeJson(path.join(project, "package.json"), {
      name: "project",
      version: "1.0.0",
      dependencies: {
        "@scope/pkg": "1.2.3"
      }
    });

    await createPackageManifest(path.join(project, "node_modules", "@scope", "pkg"), "@scope/alias", "1.2.3");
    const aliasManifest = await createPackageManifest(path.join(project, "node_modules", "alias-scoped"), "@scope/pkg", "1.2.3");
    const aliasSource = await writeSourceFile(path.join(project, "node_modules", "alias-scoped", "src", "index.ts"), "export const value = 1;\n");
    await writeSourceFile(path.join(project, "node_modules", "@scope", "pkg", "src", "index.ts"), "export const value = 1;\n");
    await createLockFile(project, "project", "1.0.0", [
      { path: "node_modules/@scope/pkg", version: "1.2.3", name: "@scope/alias" },
      { path: "node_modules/alias-scoped", version: "1.2.3", name: "@scope/pkg" }
    ], {
      dependencies: {
        "@scope/pkg": "1.2.3"
      }
    });

    const authority = await resolveProjectAuthorityForTest(project);
    assert.ok(authority);
    const result = await resolvePackageDescriptor({
      kind: "package" as const,
      manifest_sha256: aliasManifest,
      modes: ["runtime"] as const,
      package_name: "@scope/pkg",
      package_path: "./src/index.ts",
      package_version: "1.2.3",
      sha256: aliasSource
    }, [authority]);

    assert.equal(result.lockEntryPath, "node_modules/alias-scoped");
  });
});

test("type-only claim rejects non-portable path prefixes", async () => {
  const authority = await resolveToolchainAuthorityFromAnchor(fileURLToPath(import.meta.url), TOOLCHAIN_ESBUILD_VERSION, TOOLCHAIN_TYPESCRIPT_VERSION);

  await assert.rejects(
    () => buildTypeOnlyClaim({
      kind: "type-only",
      surface: "dynamics",
      package_name: "simfile" as const,
      package_version: authority.root_package_version,
      manifest_sha256: authority.root_package_sha256,
      files: [{ path: "./file:", sha256: "000000000000000000000000000000000000000000000000000000000000000000" }]
    }, authority),
    /unsafe path/
  );

  await assert.rejects(
    () => buildTypeOnlyClaim({
      kind: "type-only",
      surface: "dynamics",
      package_name: "simfile" as const,
      package_version: authority.root_package_version,
      manifest_sha256: authority.root_package_sha256,
      files: [{ path: "./C:", sha256: "000000000000000000000000000000000000000000000000000000000000000000" }]
    }, authority),
    /unsafe path/
  );

  await assert.rejects(
    () => buildTypeOnlyClaim({
      kind: "type-only",
      surface: "dynamics",
      package_name: "simfile" as const,
      package_version: authority.root_package_version,
      manifest_sha256: authority.root_package_sha256,
      files: [{ path: "./file:payload", sha256: "0000000000000000000000000000000000000000000000000000000000000000" }]
    }, authority),
    /unsafe path/
  );
});

test("portable paths reject DEL and C1 controls", () => {
  assert.throws(() => assertPortablePath(`file${String.fromCodePoint(0x7f)}name`, "DEL path"), /unsafe path/);
  assert.throws(() => assertPortablePath(`file${String.fromCodePoint(0x85)}name`, "C1 path"), /unsafe path/);
});

test("duplicate lock authorities keep the toolchain authority", async () => {
  await withTemp(async (root) => {
    const outer = path.join(root, "outer");
    await createSimfile(outer);
    await writeJson(path.join(outer, "package.json"), { name: "project", version: "1.0.0" });
    await createLockFile(outer, "project", "1.0.0", [], {});

    const projectAuthority = await resolveProjectAuthorityForTest(outer);
    assert.ok(projectAuthority);
    const lockRealPath = await realpath(projectAuthority.absoluteLockPath);
    const toolchainAuthority = await resolveToolchainAuthorityFromAnchor(fileURLToPath(import.meta.url), TOOLCHAIN_ESBUILD_VERSION, TOOLCHAIN_TYPESCRIPT_VERSION);
    const overlappingToolchainAuthority = {
      ...toolchainAuthority,
      absoluteLockRoot: outer,
      absoluteLockPath: projectAuthority.absoluteLockPath,
      absoluteLockRealPath: lockRealPath
    };

    const merged = coalesceAuthoritiesByLockRealpath([projectAuthority, overlappingToolchainAuthority]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].kind, "toolchain");
  });
});
