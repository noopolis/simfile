import assert from "node:assert/strict";
import { realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson, compareUtf16, createDynamicsClosureIdentity, sha256 } from "./buildIdentity.js";
import { DYNAMICS_BUILD_CONTRACT } from "./buildInput.js";
import { createDynamicsBuildReceipt, DYNAMICS_BUILD_RECEIPT_VERSION } from "./buildReceipt.js";
import { assertDedupedLocks } from "./buildReceiptSourceEvidence.js";
import { assertPackagePostPrepareMutationRejected, assertProjectPostPrepareMutationRejected, assertTypeOnlyPostPrepareMutationRejected, buildReceiptConfigDigest, assertDeepFrozen, assertNoForbiddenText, closurePreparationPolicy, createPackageAndTypeFixture, createSyntheticMjsFixture, reSealPrepared, scanForLeaks } from "./buildReceipt.test-helper.js";
import { createBuildTestProject, prepareBuild, removeBuildTestPaths, writeBuildFile } from "./buildTestSupport.test-helper.js";
import type { PreparedBuild } from "./buildTestSupport.test-helper.js";
import { buildReceiptLock } from "./buildReceiptLock.js";
import { resolveToolchainAuthorityFromAnchor } from "./buildReceiptLockAuthority.js";
import {
  createLockFile,
  createSymlinkDirectory,
  writeJson
} from "./buildReceiptLock.test-helper.js";

test("rejects non-canonical caller input ordering and type-only permutations", async () => {
  const fixture = await createPackageAndTypeFixture();
  try {
    await assert.rejects(
      () => createDynamicsBuildReceipt(fixture.absoluteSimfilePath, {
        ...fixture.prepared,
        inputs: [...fixture.prepared.inputs].reverse()
      }),
      /prepared\.inputs are not canonical/i
    );

    const typeOnly = fixture.prepared.inputs.find((entry) => entry.kind === "type-only");
    assert.equal(Boolean(typeOnly), true);
    if (typeOnly) {
      const reversedTypeOnly = reSealPrepared(fixture.prepared, fixture.prepared.inputs.map((entry) => entry.kind === "type-only"
        ? { ...typeOnly, files: [...typeOnly.files].reverse() }
        : entry
      ));
      await assert.rejects(
        () => createDynamicsBuildReceipt(fixture.absoluteSimfilePath, reversedTypeOnly),
        /prepared\.inputs\[\d+\]\.files\[0\]|non-canonical file order/i
      );

      const wrongSurface = reSealPrepared(fixture.prepared, fixture.prepared.inputs.map((entry) => {
        if (entry.kind !== "type-only") return entry;
        return { ...entry, surface: "runtime" } as unknown as PreparedBuild["inputs"][number];
      }));
      await assert.rejects(
        () => createDynamicsBuildReceipt(fixture.absoluteSimfilePath, wrongSurface),
        /surface: expected dynamics/i
      );
    }
  } finally {
    await removeBuildTestPaths(fixture.projectRoot);
  }
});

test("rejects invalid builtins from allowlist", async () => {
  const fixture = await createPackageAndTypeFixture();
  try {
    const invalidBuiltins = [...fixture.prepared.nodeExternals, "node:child_process"];
    const resealed = reSealPrepared({
      ...fixture.prepared,
      nodeExternals: invalidBuiltins
    }, fixture.prepared.inputs, {
      ...fixture.prepared.closureDescriptor,
      used_node_builtins: invalidBuiltins
    });
    await assert.rejects(
      () => createDynamicsBuildReceipt(fixture.absoluteSimfilePath, resealed),
      /unsupported node builtin|node builtin/i
    );
  } finally {
    await removeBuildTestPaths(fixture.projectRoot);
  }
});

test("rejects same-path conflicts across prepared descriptors", async () => {
  const fixture = await createPackageAndTypeFixture();
  try {
    const packageInput = fixture.prepared.inputs.find((entry) => entry.kind === "package");
    assert.equal(Boolean(packageInput), true);
    if (packageInput) {
      const samePathConflict = reSealPrepared(fixture.prepared, [
        ...fixture.prepared.inputs,
        { ...packageInput, sha256: "0".repeat(64) }
      ]);
      await assert.rejects(
        () => createDynamicsBuildReceipt(fixture.absoluteSimfilePath, samePathConflict),
        /same-path conflicting descriptor/i
      );
    }
  } finally {
    await removeBuildTestPaths(fixture.projectRoot);
  }
});

test("preserves B62 deduped lock ordering and uniqueness", async () => {
  const fixture = await createPackageAndTypeFixture();
  try {
    const result = await createDynamicsBuildReceipt(fixture.absoluteSimfilePath, fixture.prepared);
    const authority = await buildReceiptLock(
      fixture.absoluteSimfilePath,
      fixture.prepared.inputs.filter((entry) => entry.kind !== "project"),
      fixture.prepared.closureDescriptor.esbuild_version as string,
      fixture.prepared.closureDescriptor.typescript_version as string
    );
    const orderedByLockSha = [...authority.dedupedLocks].sort((left, right) => compareUtf16(left.lock_sha256, right.lock_sha256));
    assert.deepEqual(authority.dedupedLocks, orderedByLockSha);
    assert.deepEqual(result.payload.deduped_locks, authority.dedupedLocks);
    assert.deepEqual(assertDedupedLocks(authority.dedupedLocks), authority.dedupedLocks);
    if (authority.dedupedLocks.length > 1) {
      assert.throws(
        () => assertDedupedLocks([...authority.dedupedLocks].reverse()),
        /not ordered by lock_sha256|ambiguous/
      );
    }
  } finally {
    await removeBuildTestPaths(fixture.projectRoot);
  }
});

test("requires exactly one runtime project descriptor", async () => {
  const fixture = await createPackageAndTypeFixture();
  try {
    const projectInput = fixture.prepared.inputs.find((entry) => entry.kind === "project");
    assert.ok(projectInput);
    if (!projectInput) return;

    const extraSource = "export const extra = 1;\n";
    await writeFile(`${fixture.projectRoot}/systems/extra.ts`, extraSource);
    const withExtraProject = reSealPrepared(fixture.prepared, [...fixture.prepared.inputs, {
      kind: "project",
      modes: ["runtime"],
      path: "./systems/extra.ts",
      sha256: sha256(extraSource)
    }]);
    await createDynamicsBuildReceipt(fixture.absoluteSimfilePath, withExtraProject);

    const projectCases: readonly [readonly PreparedBuild["inputs"][number][], RegExp][] = [
      [fixture.prepared.inputs.filter((entry) => entry.kind !== "project"), /exactly one project descriptor/i],
      [[...fixture.prepared.inputs, { ...projectInput, sha256: `${projectInput.sha256.slice(0, 63)}f` }], /same-path conflicting descriptor/i],
      [fixture.prepared.inputs.map((entry) => entry.kind === "project" ? { ...entry, modes: ["type-only"] } : entry), /runtime mode/i]
    ];
    for (const [inputs, pattern] of projectCases) {
      await assert.rejects(
        () => createDynamicsBuildReceipt(fixture.absoluteSimfilePath, reSealPrepared(fixture.prepared, inputs)),
        pattern
      );
    }
  } finally {
    await removeBuildTestPaths(fixture.projectRoot);
  }
});

test("rejects closure and config mismatches and stale digests", async () => {
  const fixture = await createPackageAndTypeFixture();
  try {
    const closureMutations = [
      [{ ...fixture.prepared.closureDescriptor, used_node_builtins: [...fixture.prepared.closureDescriptor.used_node_builtins as readonly string[], "node:buffer"] }, /used_node_builtins|mismatch|closure/i],
      [{ ...fixture.prepared.closureDescriptor, typescript_version: "0.0.0" }, /toolchain|types|closure/i],
      [{ ...fixture.prepared.closureDescriptor, build_contract: {} }, /build_contract|canonical/i]
    ] as const;
    for (const [descriptor, pattern] of closureMutations) {
      await assert.rejects(
        () => createDynamicsBuildReceipt(fixture.absoluteSimfilePath, { ...fixture.prepared, closureDescriptor: descriptor }),
        pattern
      );
    }

    const staleMutations: ReadonlyArray<[PreparedBuild, RegExp]> = [
      [{ ...fixture.prepared, artifactSha256: "0".repeat(64) }, /prepared artifact SHA mismatch/i],
      [{ ...fixture.prepared, closureSha256: "0".repeat(64) }, /prepared closure SHA mismatch/i]
    ];
    for (const [prepared, pattern] of staleMutations) {
      await assert.rejects(
        () => createDynamicsBuildReceipt(fixture.absoluteSimfilePath, prepared),
        pattern
      );
    }

    const headerCorrupted = [...fixture.prepared.artifactBytes];
    const first = headerCorrupted[0];
    if (first !== undefined) headerCorrupted[0] = first === 10 ? 11 : 10;
    await assert.rejects(
      () => createDynamicsBuildReceipt(fixture.absoluteSimfilePath, {
        ...fixture.prepared,
        artifactBytes: headerCorrupted,
        artifactSha256: sha256(Uint8Array.from(headerCorrupted))
      }),
      /artifact header mismatch|header/i
    );
  } finally {
    await removeBuildTestPaths(fixture.projectRoot);
  }
});

test("rejects project post-prepare mutation independently", assertProjectPostPrepareMutationRejected);
test("rejects package post-prepare mutation independently", assertPackagePostPrepareMutationRejected);
test("rejects type-only post-prepare mutation independently", assertTypeOnlyPostPrepareMutationRejected);

test("rejects hostile serialized package identity metadata", async () => {
  const fixture = await createPackageAndTypeFixture();
  try {
    const packageInput = fixture.prepared.inputs.find((entry) => entry.kind === "package");
    assert.ok(packageInput);
    if (!packageInput) return;
    const hostileMutations: readonly [PreparedBuild["inputs"][number], RegExp][] = [
      [{ ...packageInput, package_name: "project?secret" }, /package_name|invalid npm package/i],
      [{ ...packageInput, package_version: "1.0.0#token" }, /package_version|invalid npm package/i],
      [{ ...packageInput, package_name: "https://example.com/pkg" }, /package_name|invalid npm package/i],
      [{ ...packageInput, package_name: `fixture-pkg${"\u0007"}` }, /package_name|control/i]
    ];
    for (const [patchedPackage, pattern] of hostileMutations) {
      const hostile = reSealPrepared(
        fixture.prepared,
        fixture.prepared.inputs.map((entry) => entry.kind === "package" ? patchedPackage : entry)
      );
      await assert.rejects(() => createDynamicsBuildReceipt(fixture.absoluteSimfilePath, hostile), pattern);
    }
  } finally {
    await removeBuildTestPaths(fixture.projectRoot);
  }
});

test("scans receipt bytes and payload for root/registry/secret/URL/query/fragment/control leakage", async () => {
  const fixture = await createPackageAndTypeFixture();
  try {
    const result = await createDynamicsBuildReceipt(fixture.absoluteSimfilePath, fixture.prepared);
    const authority = fixture.authority;
    const forbiddenRoots = [
      fixture.projectRoot,
      authority.absoluteToolchainRoot,
      authority.absoluteProjectRoot,
      authority.toolchainAuthority.absoluteLockPath,
      authority.projectAuthority.absoluteLockPath ?? ""
    ];

    scanForLeaks(result.payload, result.receiptBytes, forbiddenRoots);

    const receiptText = String.fromCharCode(...result.receiptBytes);
    assert.equal(/https?:\/\//u.test(receiptText), false);
    assert.equal(receiptText.includes("?"), false);
    assert.equal(receiptText.includes("#"), false);
    for (const value of [receiptText]) {
      assertNoForbiddenText(value, [fixture.projectRoot]);
      assert.equal(value.includes("registry"), false);
      assert.equal(value.includes("secret"), false);
      assert.equal(value.includes("token"), false);
    }
  } finally {
    await removeBuildTestPaths(fixture.projectRoot);
  }
});
