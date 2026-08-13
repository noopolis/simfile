import "./buildReceiptLockAuthority.test-helper.js";

import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  buildReceiptLock,
  compareDynamicsReceiptLockPortableRecords,
  type DynamicsReceiptLockPortableRecord
} from "./buildReceiptLock.js";
import {
  createLockFile,
  createPackageManifest,
  createSimfile,
  createSymlinkDirectory,
  createSymlinkFile,
  withTemp,
  writeJson,
  writeSourceFile
} from "./buildReceiptLock.test-helper.js";

const TOOLCHAIN_ESBUILD_VERSION = "0.28.1";
const TOOLCHAIN_TYPESCRIPT_VERSION = "5.9.3";

const assertDeepFrozen = (value: unknown, label: string): void => {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true, `${label} should be frozen`);
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      assertDeepFrozen(child, `${label}[${index}]`);
    }
    return;
  }
  for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
    assertDeepFrozen(child, `${label}.${name}`);
  }
};

const assertNoPortals = (claim: {
  readonly source_digests: readonly { readonly path: string }[];
  readonly tool_identities: readonly { readonly lock_entry_path: string }[];
}): void => {
  for (const source of claim.source_digests) {
    assert.equal(path.isAbsolute(source.path), false, `absolute path leaked: ${source.path}`);
    assert.equal(path.posix.isAbsolute(source.path), false, `claim path absolute: ${source.path}`);
    assert.equal(/\x00/.test(source.path), false, `control char leaked: ${source.path}`);
    assert.equal(/\?/.test(source.path), false, `query leaked: ${source.path}`);
    assert.equal(/#/.test(source.path), false, `fragment leaked: ${source.path}`);
    assert.equal(/https?:\/\//.test(source.path), false, `url leaked: ${source.path}`);
  }
  for (const tool of claim.tool_identities) {
    assert.equal(path.isAbsolute(tool.lock_entry_path), false, `absolute tool path leaked: ${tool.lock_entry_path}`);
    assert.equal(/[\\]/.test(tool.lock_entry_path), false, `platform path leaked: ${tool.lock_entry_path}`);
  }
};

test("buildReceiptLock API is issuer-only", () => {
  assert.equal(buildReceiptLock.length, 4);
});

test("portable claim ordering includes authority identity", () => {
  const base: DynamicsReceiptLockPortableRecord = {
    manager: "npm",
    lockfile_version: 3,
    root_package_name: "a",
    root_package_version: "1.0.0",
    root_package_sha256: "a".repeat(64),
    lock_sha256: "b".repeat(64),
    lock_entry_path: "node_modules/pkg",
    package_name: "pkg",
    package_version: "1.0.0",
    package_manifest_sha256: "c".repeat(64),
    source_digests: [{ path: "./index.js", sha256: "d".repeat(64) }],
    tool_identities: []
  };
  const differentAuthority = { ...base, root_package_name: "b" };
  assert.ok(compareDynamicsReceiptLockPortableRecords(base, differentAuthority) < 0);
  assert.ok(compareDynamicsReceiptLockPortableRecords(differentAuthority, base) > 0);
  assert.deepEqual(
    [differentAuthority, base].sort(compareDynamicsReceiptLockPortableRecords).map((claim) => claim.root_package_name),
    ["a", "b"]
  );
});

test("simfile path must be absolute regular non-symlink", async () => {
  await withTemp(async (root) => {
    const project = path.join(root, "project");
    const simfile = await createSimfile(project);

    await assert.rejects(
      () => buildReceiptLock("project/Simfile", [], TOOLCHAIN_ESBUILD_VERSION, TOOLCHAIN_TYPESCRIPT_VERSION),
      /must be absolute/
    );

    const real = path.join(root, "real");
    const realSimfile = path.join(real, "Simfile");
    await createSimfile(real);
    await createSymlinkDirectory(real, path.join(root, "linked"));
    await assert.rejects(
      () => buildReceiptLock(path.join(root, "linked", "Simfile"), [], TOOLCHAIN_ESBUILD_VERSION, TOOLCHAIN_TYPESCRIPT_VERSION),
      /forbidden symlink/
    );

    const fileLink = path.join(root, "file-link");
    await createSymlinkFile(realSimfile, fileLink);
    await assert.rejects(
      () => buildReceiptLock(fileLink, [], TOOLCHAIN_ESBUILD_VERSION, TOOLCHAIN_TYPESCRIPT_VERSION),
      /forbidden symlink/
    );

    await mkdir(path.join(project, "is-dir"));
    await assert.rejects(
      () => buildReceiptLock(path.join(project, "is-dir"), [], TOOLCHAIN_ESBUILD_VERSION, TOOLCHAIN_TYPESCRIPT_VERSION),
      /non-file path/
    );

    const result = await buildReceiptLock(simfile, [], TOOLCHAIN_ESBUILD_VERSION, TOOLCHAIN_TYPESCRIPT_VERSION);
    assert.equal(result.projectAuthority.absoluteLockRoot, null);

    await withTemp(async (projectRoot) => {
      const partial = path.join(projectRoot, "project");
      const partialSimfile = await createSimfile(partial);
      await writeJson(path.join(partial, "package.json"), { name: "project", version: "1.0.0" });
      await assert.rejects(
        () => buildReceiptLock(partialSimfile, [], TOOLCHAIN_ESBUILD_VERSION, TOOLCHAIN_TYPESCRIPT_VERSION),
        /partial project authority/
      );
    });

    await withTemp(async (lockRoot) => {
      const partial = path.join(lockRoot, "project");
      const partialSimfile = await createSimfile(partial);
      await writeJson(path.join(partial, "package-lock.json"), {
        lockfileVersion: 3,
        packages: {}
      });
      await assert.rejects(
        () => buildReceiptLock(partialSimfile, [], TOOLCHAIN_ESBUILD_VERSION, TOOLCHAIN_TYPESCRIPT_VERSION),
        /partial project authority/
      );
    });
  });
});

test("portable claims are deterministic and POSIX", async () => {
  await withTemp(async (root) => {
    const project = path.join(root, "project");
    const simfile = await createSimfile(project);

    const fixtureRoot = path.join(project, "node_modules", "fixture-pkg");
    const manifest = await createPackageManifest(fixtureRoot, "fixture-pkg", "1.2.3");
    const sourceOne = await writeSourceFile(path.join(fixtureRoot, "src", "alpha.ts"), "export const value = 1;\n");
    const sourceTwo = await writeSourceFile(path.join(fixtureRoot, "src", "omega.ts"), "export const value = 2;\n");

    await writeJson(path.join(project, "package.json"), {
      name: "project",
      version: "1.0.0",
      dependencies: {
        fixture: "1.2.3",
        esbuild: TOOLCHAIN_ESBUILD_VERSION,
        typescript: TOOLCHAIN_TYPESCRIPT_VERSION
      }
    });

    await createLockFile(project, "project", "1.0.0", [
      { path: "node_modules/fixture-pkg", version: "1.2.3", name: "fixture-pkg" }
    ], {
      dependencies: {
        fixture: "1.2.3",
        esbuild: TOOLCHAIN_ESBUILD_VERSION,
        typescript: TOOLCHAIN_TYPESCRIPT_VERSION
      }
    });

    const primary = {
      kind: "package" as const,
      manifest_sha256: manifest,
      modes: ["runtime"] as const,
      package_name: "fixture-pkg",
      package_version: "1.2.3",
      package_path: "./src/omega.ts",
      sha256: sourceTwo
    };
    const secondary = {
      kind: "package" as const,
      manifest_sha256: manifest,
      modes: ["runtime"] as const,
      package_name: "fixture-pkg",
      package_version: "1.2.3",
      package_path: "./src/alpha.ts",
      sha256: sourceOne
    };

    const result = await buildReceiptLock(simfile, [
      secondary,
      primary
    ], TOOLCHAIN_ESBUILD_VERSION, TOOLCHAIN_TYPESCRIPT_VERSION);

    assert.deepEqual(result.portableClaims.map((claim) => claim.source_digests[0].path), [
      "./src/alpha.ts",
      "./src/omega.ts"
    ]);

    const fixture = result.portableClaims.find((claim) => claim.package_name === "fixture-pkg");
    assert.ok(fixture);
    assert.equal(fixture.lock_entry_path, "node_modules/fixture-pkg");
    assert.equal(fixture.source_digests[0].path, "./src/alpha.ts");
    assert.equal(fixture.source_digests[0].sha256, sourceOne);

    assert.equal(result.toolchainAuthority.tool_identities.length, 2);
    for (const tool of result.toolchainAuthority.tool_identities) {
      assert.equal(/[\\]/.test(tool.lock_entry_path), false, `tool path not posix: ${tool.lock_entry_path}`);
    }
    assert.equal(result.toolchainAuthority.tool_identities[0].lock_entry_path, "node_modules/esbuild");
    assert.deepEqual(result.selfLinkEntries, []);

    for (const claim of result.portableClaims) {
      assertNoPortals(claim);
      assertDeepFrozen(claim, "claim");
    }
    assertDeepFrozen(result, "result");
  });
});

test("package descriptor ambiguity is rejected", async () => {
  await withTemp(async (root) => {
    const packageName = "fixture-pkg-local";
    const project = path.join(root, "project");
    const simfile = await createSimfile(project);

    await writeJson(path.join(project, "package.json"), {
      name: "project",
      version: "1.0.0",
      dependencies: {
        [packageName]: "1.2.3",
        esbuild: TOOLCHAIN_ESBUILD_VERSION,
        typescript: TOOLCHAIN_TYPESCRIPT_VERSION
      }
    });
    const pkgRoot = path.join(project, "node_modules", packageName);
    const manifest = await createPackageManifest(pkgRoot, packageName, "1.2.3");
    const source = await writeSourceFile(path.join(pkgRoot, "src", "index.ts"), "export const value = 1;\n");

    await createLockFile(project, "project", "1.0.0", [{ path: `node_modules/${packageName}`, version: "9.9.9" }], {
      dependencies: { [packageName]: "1.2.3", esbuild: TOOLCHAIN_ESBUILD_VERSION, typescript: TOOLCHAIN_TYPESCRIPT_VERSION }
    });
    await assert.rejects(
      () => buildReceiptLock(simfile, [{
        kind: "package" as const,
        manifest_sha256: manifest,
        modes: ["runtime"] as const,
        package_name: packageName,
        package_path: "./src/index.ts",
        package_version: "1.2.3",
        sha256: source
      }], TOOLCHAIN_ESBUILD_VERSION, TOOLCHAIN_TYPESCRIPT_VERSION),
      /missing package lock evidence/
    );

    await createLockFile(project, "project", "1.0.0", [
      { path: `node_modules/${packageName}`, version: "1.2.3" },
      { path: `node_modules/wrapper/node_modules/${packageName}`, version: "1.2.3" }
    ], {
      dependencies: {
        [packageName]: "1.2.3",
        esbuild: TOOLCHAIN_ESBUILD_VERSION,
        typescript: TOOLCHAIN_TYPESCRIPT_VERSION
      }
    });
    await createPackageManifest(path.join(project, "node_modules", "wrapper", "node_modules", packageName), packageName, "1.2.3");
    await writeSourceFile(path.join(project, "node_modules", "wrapper", "node_modules", packageName, "src", "index.ts"), "export const value = 1;\n");
    await assert.rejects(
      () => buildReceiptLock(simfile, [{
        kind: "package" as const,
        manifest_sha256: manifest,
        modes: ["runtime"] as const,
        package_name: packageName,
        package_path: "./src/index.ts",
        package_version: "1.2.3",
        sha256: source
      }], TOOLCHAIN_ESBUILD_VERSION, TOOLCHAIN_TYPESCRIPT_VERSION),
      /ambiguous package lock evidence/
    );
  });
});

test("symlinked package directory component is rejected", async () => {
  await withTemp(async (root) => {
    const project = path.join(root, "project");
    const simfile = await createSimfile(project);
    await writeJson(path.join(project, "package.json"), {
      name: "project",
      version: "1.0.0",
      dependencies: {
        "fixture-pkg": "1.2.3",
        esbuild: TOOLCHAIN_ESBUILD_VERSION,
        typescript: TOOLCHAIN_TYPESCRIPT_VERSION
      }
    });

    const real = path.join(project, "real", "node_modules", "fixture-pkg");
    const manifest = await createPackageManifest(real, "fixture-pkg", "1.2.3");
    const source = await writeSourceFile(path.join(real, "src", "index.ts"), "export const value = 1;\n");
    await createSymlinkDirectory(real, path.join(project, "node_modules", "fixture-pkg"));
    await createLockFile(project, "project", "1.0.0", [{ path: "node_modules/fixture-pkg", version: "1.2.3" }], {
      dependencies: { "fixture-pkg": "1.2.3", esbuild: TOOLCHAIN_ESBUILD_VERSION, typescript: TOOLCHAIN_TYPESCRIPT_VERSION }
    });

    await assert.rejects(
      () => buildReceiptLock(simfile, [{
        kind: "package" as const,
        manifest_sha256: manifest,
        modes: ["runtime"] as const,
        package_name: "fixture-pkg",
        package_path: "./src/index.ts",
        package_version: "1.2.3",
        sha256: source
      }], TOOLCHAIN_ESBUILD_VERSION, TOOLCHAIN_TYPESCRIPT_VERSION),
      /forbidden symlink/
    );
  });
});
