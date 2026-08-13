import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalJson, createDynamicsClosureIdentity, sha256 } from "./buildIdentity.js";
import { DYNAMICS_BUILD_CONTRACT } from "./buildInput.js";
import { createDynamicsBuildReceipt, DYNAMICS_BUILD_RECEIPT_VERSION } from "./buildReceipt.js";
import {
  assertDeepFrozen,
  buildReceiptConfigDigest,
  closurePreparationPolicy,
  createPackageAndTypeFixture,
  createSyntheticMjsFixture,
  reSealPrepared,
} from "./buildReceipt.test-helper.js";
import { buildReceiptLock } from "./buildReceiptLock.js";
import { resolveToolchainAuthorityFromAnchor } from "./buildReceiptLockAuthority.js";
import {
  createLockFile,
  createSymlinkDirectory,
  writeJson,
} from "./buildReceiptLock.test-helper.js";
import {
  createBuildTestProject,
  prepareBuild,
  removeBuildTestPaths,
  writeBuildFile,
} from "./buildTestSupport.test-helper.js";

const assertReceiptBytes = (left: readonly number[], right: readonly number[]): void => {
  assert.equal(left.length, right.length);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) assert.fail(`receipt byte mismatch @${index}`);
  }
};

test("createDynamicsBuildReceipt API is issuer-only", () => {
  assert.equal(createDynamicsBuildReceipt.length, 2);
});

test("creates deterministic receipt for synthetic .mjs project", async () => {
  const fixture = await createSyntheticMjsFixture();
  try {
    const result = await createDynamicsBuildReceipt(fixture.absoluteSimfilePath, fixture.prepared);
    const expectedClosure = createDynamicsClosureIdentity({
      buildContract: DYNAMICS_BUILD_CONTRACT,
      entry: fixture.prepared.module,
      esbuildVersion: fixture.prepared.closureDescriptor.esbuild_version as string,
      inputs: fixture.prepared.inputs,
      preparationPolicy: closurePreparationPolicy,
      typecheckMode: fixture.prepared.typecheckMode,
      typescriptVersion: fixture.prepared.closureDescriptor.typescript_version as string,
      usedNodeBuiltins: fixture.prepared.nodeExternals,
    });
    assert.equal(result.payload.schema, DYNAMICS_BUILD_RECEIPT_VERSION);
    assert.equal((result.payload as { version?: string }).version, undefined);
    assert.equal((result.payload as { closure_descriptor?: object }).closure_descriptor, undefined);
    assert.equal(result.payload.module, fixture.prepared.module);
    assert.deepEqual(result.payload.source_graph, JSON.parse(canonicalJson(fixture.prepared.inputs)));
    assert.deepEqual(result.payload.source_graph_sha256, sha256(canonicalJson(result.payload.source_graph)));
    assert.equal(result.payload.build_config_sha256, buildReceiptConfigDigest);
    assert.equal(result.payload.closure_header, expectedClosure.header);
    assert.equal(result.payload.closure_sha256, expectedClosure.sha256);
    assert.deepEqual(result.payload.used_node_externals, fixture.prepared.nodeExternals);
    assert.deepEqual(result.payload.runtime_identity, {
      platform: process.platform, arch: process.arch, node: process.versions.node, v8: process.versions.v8,
    });
    assert.equal(result.payload.artifact_sha256, fixture.prepared.artifactSha256);
    assert.equal(result.payload.artifact_path,
      `./dynamics/sha256-${fixture.prepared.artifactSha256}/provider.mjs`);
    assert.deepEqual(result.payload.self_link_entries, []);
    assert.equal(Object.isFrozen(result.payload.self_link_entries), true);
    const expectedBytes = new TextEncoder().encode(`${canonicalJson(result.payload)}\n`);
    assertReceiptBytes(result.receiptBytes, Array.from(expectedBytes));
    assert.equal(Buffer.from(result.receiptBytes).toString("utf8").includes("\"self_link_entries\":[]"), true);
    assert.equal(result.receiptBytes[result.receiptBytes.length - 1], 10);
    assert.equal(result.receiptSha256, sha256(Uint8Array.from(result.receiptBytes)));
    assertDeepFrozen(result, "result");
  } finally {
    await removeBuildTestPaths(fixture.projectRoot);
  }
});

test("serializes a canonical project self-link without checkout disclosure", async () => {
  const fixture = await createSyntheticMjsFixture();
  try {
    const esbuildVersion = fixture.prepared.closureDescriptor.esbuild_version as string;
    const typescriptVersion = fixture.prepared.closureDescriptor.typescript_version as string;
    const toolchain = await resolveToolchainAuthorityFromAnchor(
      fileURLToPath(import.meta.url), esbuildVersion, typescriptVersion,
    );
    const resolved = path.relative(fixture.projectRoot, toolchain.absoluteRoot).split(path.sep).join("/");
    await writeJson(path.join(fixture.projectRoot, "package.json"), {
      name: "fixture-project", version: "1.0.0", dependencies: { simfile: `file:${resolved}` },
    });
    await createLockFile(fixture.projectRoot, "fixture-project", "1.0.0", [
      { path: resolved, version: toolchain.root_package_version },
      { path: "node_modules/simfile", resolved, link: true },
    ], { dependencies: { simfile: `file:${resolved}` } });
    await createSymlinkDirectory(
      toolchain.absoluteRoot, path.join(fixture.projectRoot, "node_modules", "simfile"),
    );
    const authority = await buildReceiptLock(
      fixture.absoluteSimfilePath, [], esbuildVersion, typescriptVersion,
    );
    const first = await createDynamicsBuildReceipt(fixture.absoluteSimfilePath, fixture.prepared);
    const second = await createDynamicsBuildReceipt(fixture.absoluteSimfilePath, fixture.prepared);
    assert.deepEqual(first.payload.self_link_entries, authority.selfLinkEntries);
    assert.equal(first.payload.self_link_entries.length, 1);
    assertReceiptBytes(first.receiptBytes, second.receiptBytes);
    assertDeepFrozen(first.payload.self_link_entries, "self_link_entries");
    const receiptText = Buffer.from(first.receiptBytes).toString("utf8");
    assert.equal(receiptText.includes(resolved), false);
    assert.equal(receiptText.includes(toolchain.absoluteRoot), false);
  } finally {
    await removeBuildTestPaths(fixture.projectRoot);
  }
});

test("creates receipt directly from prepared TypeScript build with package-root type paths", async () => {
  const project = await createBuildTestProject(await realpath(os.tmpdir()));
  try {
    await writeBuildFile(project, "systems/provider.ts", [
      "import type { DynamicsJsonValue } from 'simfile/dynamics';",
      "export const value: DynamicsJsonValue = 1;",
    ].join("\n"));
    const prepared = await prepareBuild(project, "./systems/provider.ts");
    const typeSurface = prepared.inputs.find((input) => input.kind === "type-only");
    assert.ok(typeSurface);
    assert.equal(typeSurface.files.length > 0, true);
    assert.equal(typeSurface.files.every((file) => file.path.startsWith("./src/")), true);
    assert.deepEqual(typeSurface.files.filter((file) => !file.path.startsWith("./src/dynamics/"))
      .map((file) => file.path), [
      "./src/kernel/duration.ts", "./src/runtime/clock.ts", "./src/schema/identifier.ts",
      "./src/schema/model.ts",
      ...["authority", "definition", "index", "invoke", "observation", "own-data",
        "recommendation", "rejection", "schema-value", "schema", "synchrony", "types"]
        .map((file) => `./src/world-surface/${file}.ts`),
      ...["act", "actEnvelope", "actTypes", "actionJournal", "actionJournalInspection",
        "actionJournalSnapshot", "actionRefusalJournal", "actionResult", "actionResultLedger",
        "actionResultLedgerInspection", "actionResultLedgerSnapshot", "actionResultProjection",
        "actionResults", "addresses", "affordances", "capabilityManifest", "checkpoint",
        "checkpointDynamicsSnapshot", "checkpointRelations", "checkpointRestore",
        "checkpointRuntime", "checkpointSnapshot", "clockAuthority", "controllerAuthority",
        "decisionClaim", "decisionRegistry", "decisionRegistryInput", "decisionRegistrySnapshot",
        "decisionResultReadAdmission", "grantAttestation", "grantComposition", "grants",
        "hostileJson", "index", "ledger", "observe", "readLedgerSnapshot", "requestLedger",
        "requestLedgerInspection", "requestLedgerSnapshot", "runtime", "runtimeComposition"]
        .map((file) => `./src/world/${file}.ts`),
    ]);
    assert.equal(prepared.inputs.some((input) =>
      input.kind === "package" && input.package_name === "simfile"), false);
    const receipt = await createDynamicsBuildReceipt(project.simfilePath, prepared);
    assert.deepEqual(receipt.payload.source_graph, prepared.inputs);
    assert.equal(receipt.payload.closure_sha256, prepared.closureSha256);
  } finally {
    await removeBuildTestPaths(project.directory);
  }
});

test("creates package evidence and one-file type-only classification", async () => {
  const fixture = await createPackageAndTypeFixture();
  try {
    const baseline = await createDynamicsBuildReceipt(fixture.absoluteSimfilePath, fixture.prepared);
    const packageClaims = baseline.payload.portable_claims.filter((claim) =>
      claim.tool_identities.length === 0);
    const oneFileTypeClaims = baseline.payload.portable_claims.filter((claim) =>
      claim.tool_identities.length === 2);
    assert.equal(packageClaims.length, 1);
    assert.equal(oneFileTypeClaims.length, 1);
    const packageClaim = packageClaims[0]!;
    assert.equal(packageClaim.package_name, fixture.packageInput.package_name);
    assert.equal(packageClaim.package_version, fixture.packageInput.package_version);
    assert.equal(packageClaim.package_manifest_sha256, fixture.packageInput.manifest_sha256);
    assert.deepEqual(packageClaim.source_digests, [{
      path: fixture.packageInput.package_path, sha256: fixture.packageInput.sha256,
    }]);
    assert.equal(packageClaim.tool_identities.length, 0);
    const oneFileTypeInput = {
      ...fixture.typeOnlyInput, files: [...fixture.typeOnlyInput.files.slice(0, 1)],
    };
    const oneFilePrepared = reSealPrepared(
      fixture.prepared,
      fixture.prepared.inputs.map((entry) => entry.kind === "type-only" ? oneFileTypeInput : entry),
    );
    const result = await createDynamicsBuildReceipt(fixture.absoluteSimfilePath, oneFilePrepared);
    const claims = result.payload.portable_claims.filter((claim) => claim.tool_identities.length === 2);
    assert.equal(claims.length, 1);
    assert.equal(claims[0]!.source_digests.length, 1);
    assert.equal(claims[0]!.tool_identities.length, 2);
    assert.equal(claims[0]!.package_name, fixture.typeOnlyInput.package_name);
  } finally {
    await removeBuildTestPaths(fixture.projectRoot);
  }
});

test("requires redundant typecheck mode equality", async () => {
  const fixture = await createPackageAndTypeFixture();
  try {
    await assert.rejects(() => createDynamicsBuildReceipt(fixture.absoluteSimfilePath, {
      ...fixture.prepared,
      typecheckMode: fixture.prepared.typecheckMode === "none" ? "typescript" : "none",
    }), /prepared\.typecheckMode mismatch/i);
  } finally {
    await removeBuildTestPaths(fixture.projectRoot);
  }
});

test("requires type-only claims to reuse authoritative buildTools", async () => {
  const fixture = await createPackageAndTypeFixture();
  try {
    const result = await createDynamicsBuildReceipt(fixture.absoluteSimfilePath, fixture.prepared);
    const claims = result.payload.portable_claims.filter((claim) => claim.tool_identities.length === 2);
    assert.equal(claims.length, 1);
    assert.equal(canonicalJson(claims[0]!.tool_identities), canonicalJson(result.payload.build_tools));
  } finally {
    await removeBuildTestPaths(fixture.projectRoot);
  }
});
