import assert from "node:assert/strict";
import { readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  compareUtf16,
  createDynamicsClosureIdentity,
  canonicalJson,
  sha256,
  type DynamicsBuildInputDescriptor
} from "./buildIdentity.js";
import { DYNAMICS_BUILD_CONTRACT, DYNAMICS_BUILD_PREPARATION_POLICY } from "./buildInput.js";
import { DYNAMICS_STATIC_CLOSURE_POLICY } from "./buildStaticPolicy.js";
import { buildReceiptLock } from "./buildReceiptLock.js";
import { createDynamicsBuildReceipt } from "./buildReceipt.js";
import {
  collectStringValues,
  createBuildTestProject,
  prepareBuild,
  writeBuildFile,
  removeBuildTestPaths,
  type PreparedBuild
} from "./buildTestSupport.test-helper.js";
import {
  createLockFile,
  createPackageManifest,
  writeSourceFile
} from "./buildReceiptLock.test-helper.js";

export const DYNAMICS_BUILD_RECEIPT_SCHEMA = "simfile.dynamics-build-receipt.v1" as const;
export const closurePreparationPolicy = {
  ...DYNAMICS_BUILD_PREPARATION_POLICY,
  staticClosure: DYNAMICS_STATIC_CLOSURE_POLICY
};
export const buildReceiptConfigDigest = sha256(canonicalJson({
  buildContract: DYNAMICS_BUILD_CONTRACT,
  preparationPolicy: closurePreparationPolicy
}));

export interface ReceiptFixture {
  readonly absoluteSimfilePath: string;
  readonly prepared: PreparedBuild;
  readonly projectRoot: string;
}

export interface PackageTypeFixture {
  readonly packageAndTypePrepared: PreparedBuild;
  readonly packageInput: DynamicsBuildInputDescriptor & { readonly kind: "package" };
  readonly typeOnlyInput: DynamicsBuildInputDescriptor & { readonly kind: "type-only" };
}

export interface ReceiptAuthoritySet {
  readonly authority: Awaited<ReturnType<typeof buildReceiptLock>>;
  readonly lockInputs: readonly (DynamicsBuildInputDescriptor & { readonly kind: "package" | "type-only" })[];
}

export const normalizeByCanonical = <T>(value: readonly T[]): string =>
  canonicalJson([...value].sort((left, right) => compareUtf16(canonicalJson(left as Record<string, unknown>), canonicalJson(right as Record<string, unknown>))));

export const normalizeByDescriptor = <T>(value: readonly T[]): T[] =>
  [...value].sort((left, right) => compareUtf16(canonicalJson(left as Record<string, unknown>), canonicalJson(right as Record<string, unknown>)));

export const assertDeepFrozen = (value: unknown, label: string): void => {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true, `${label} is not frozen`);
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertDeepFrozen(child, `${label}[${index}]`));
    return;
  }
  for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
    assertDeepFrozen(child, `${label}.${name}`);
  }
};

export const assertNoForbiddenText = (value: string, forbiddenRoots: readonly string[]): void => {
  const lowered = value.toLowerCase();
  for (const root of forbiddenRoots) {
    if (root === "") continue;
    const candidate = path.resolve(root);
    const portable = candidate.replaceAll(path.sep, "/");
    if (value.includes(root) || value.includes(candidate) || value.includes(portable)) {
      assert.fail(`forbidden filesystem path: ${value}`);
    }
  }

  if (/[A-Za-z]:\\/u.test(value)) assert.fail(`windows path leak: ${value}`);
  if (/\r/u.test(value)) assert.fail(`CRLF leak: ${value}`);
  if (value.includes("?")) assert.fail(`query leak: ${value}`);
  if (value.includes("#")) assert.fail(`fragment leak: ${value}`);
  if (value.includes("\0")) assert.fail(`NUL leak: ${value}`);
  if (/\u0000|[\x01-\x08\x0b\x0c\x0e-\x1f]/u.test(value)) assert.fail(`control leak: ${value}`);
  if (/https?:\/\//u.test(value)) assert.fail(`URL leak: ${value}`);
  if (/\bregistry\b|\bsecret\b|\btoken\b/u.test(lowered)) assert.fail(`marker leak: ${value}`);
};

export const scanForLeaks = (
  payload: unknown,
  receiptBytes: readonly number[],
  forbiddenRoots: readonly string[]
): void => {
  const values = [
    ...collectStringValues(payload),
    String.fromCharCode(...receiptBytes)
  ];
  for (const value of values) {
    assertNoForbiddenText(value, forbiddenRoots);
  }
};

export const buildVersions = (prepared: PreparedBuild): { esbuild: string; typescript: string } => ({
  esbuild: prepared.closureDescriptor.esbuild_version as string,
  typescript: prepared.closureDescriptor.typescript_version as string
});

export const reSealPrepared = (
  prepared: PreparedBuild,
  inputs: readonly PreparedBuild["inputs"][number][],
  closureDescriptor?: Readonly<Record<string, unknown>>
): PreparedBuild => {
  const descriptor = closureDescriptor ?? (prepared.closureDescriptor as Readonly<Record<string, unknown>>);
  const nextInputs = normalizeByDescriptor(inputs);
  const nextClosure = createDynamicsClosureIdentity({
    buildContract: DYNAMICS_BUILD_CONTRACT,
    entry: prepared.module,
    esbuildVersion: descriptor.esbuild_version as string,
    inputs: nextInputs,
    preparationPolicy: closurePreparationPolicy,
    typecheckMode: prepared.typecheckMode,
    typescriptVersion: descriptor.typescript_version as string,
    usedNodeBuiltins: normalizeByDescriptor(prepared.nodeExternals as readonly string[])
  });

  const oldHeader = new TextEncoder().encode(`/* simfile-dynamics-closure-sha256:${prepared.closureSha256} */\n`);
  const body = prepared.artifactBytes.slice(oldHeader.length);
  const nextHeader = new TextEncoder().encode(nextClosure.header);
  const artifactBytes = new Uint8Array(nextHeader.length + body.length);
  artifactBytes.set(nextHeader);
  artifactBytes.set(Uint8Array.from(body), nextHeader.length);

  return {
    ...prepared,
    artifactBytes: Array.from(artifactBytes),
    artifactSha256: sha256(artifactBytes),
    closureDescriptor: nextClosure.descriptor,
    closureSha256: nextClosure.sha256,
    inputs: nextInputs,
    nodeExternals: normalizeByDescriptor(prepared.nodeExternals as readonly string[])
  };
};

export const createSyntheticMjsFixture = async (): Promise<ReceiptFixture> => {
  let project: Awaited<ReturnType<typeof createBuildTestProject>> | undefined;
  try {
    const parent = await realpath(os.tmpdir());
    project = await createBuildTestProject(parent);
    await writeBuildFile(project, "systems/provider.mjs", "export const value = 1;\n");
    const prepared = await prepareBuild(project, "./systems/provider.mjs");
    const projectInputs = prepared.inputs.filter((entry) => entry.kind === "project");
    const resealed = reSealPrepared(prepared, projectInputs);
    return {
      absoluteSimfilePath: project.simfilePath,
      prepared: resealed,
      projectRoot: project.directory
    };
  } catch (error) {
    if (project) await removeBuildTestPaths(project.directory);
    throw error;
  }
};

export const createPackageAndTypeFixture = async (): Promise<ReceiptFixture & ReceiptAuthoritySet & PackageTypeFixture> => {
  let project: Awaited<ReturnType<typeof createBuildTestProject>> | undefined;
  try {
    const parent = await realpath(os.tmpdir());
    project = await createBuildTestProject(parent);

    await createPackageManifest(path.join(project.directory, "node_modules", "fixture-pkg"), "fixture-pkg", "1.2.3", {
      type: "module",
      main: "./index.ts"
    });
    await writeSourceFile(path.join(project.directory, "node_modules", "fixture-pkg", "index.ts"), "export const fixture = 11;\n");
    await writeBuildFile(project, "systems/provider.ts", [
      'import { fixture } from "fixture-pkg";',
      "export const value = fixture;"
    ].join("\n") + "\n");
    await writeSourceFile(path.join(project.directory, "package.json"), JSON.stringify({
      name: "fixture-project",
      version: "1.0.0",
      type: "module",
      dependencies: { "fixture-pkg": "1.2.3" }
    }));

    await createLockFile(project.directory, "fixture-project", "1.0.0", [{ path: "node_modules/fixture-pkg", version: "1.2.3" }], {
      dependencies: {
        "fixture-pkg": "1.2.3"
      }
    });

    const prepared = await prepareBuild(project, "./systems/provider.ts");
    const versions = buildVersions(prepared);
    const authority = await buildReceiptLock(project.simfilePath, [], versions.esbuild, versions.typescript);

    const packageInput = prepared.inputs.find((entry): entry is (DynamicsBuildInputDescriptor & { kind: "package" }) =>
      entry.kind === "package" && entry.package_name === "fixture-pkg"
    );
    const projectInput = prepared.inputs.find((entry): entry is (DynamicsBuildInputDescriptor & { kind: "project" }) =>
      entry.kind === "project"
    );

    if (!packageInput) {
      assert.fail("missing fixture package input");
    }
    if (!projectInput) {
      assert.fail("missing project input");
    }

    if (authority.toolchainAuthority.root_package_name !== "simfile") {
      assert.fail("unexpected toolchain root package name");
    }

    const typeOnlyFiles = [
      "./src/dynamics/buildReceiptLock.ts",
      "./src/dynamics/buildReceiptLockAuthority.ts"
    ] as const;
    const typeOnlyInputs = await Promise.all(typeOnlyFiles.map(async (candidate) => ({
      path: candidate,
      sha256: sha256(await readFile(path.join(authority.absoluteToolchainRoot, candidate.slice(2)), "utf8"))
    })));
    const typeOnlyInput: DynamicsBuildInputDescriptor & { readonly kind: "type-only" } = {
      kind: "type-only",
      files: normalizeByDescriptor(typeOnlyInputs),
      manifest_sha256: authority.toolchainAuthority.root_package_sha256,
      package_name: "simfile",
      package_version: authority.toolchainAuthority.root_package_version,
      surface: "dynamics"
    };

    const resealed = reSealPrepared(prepared, [projectInput, packageInput, typeOnlyInput]);
    return {
      absoluteSimfilePath: project.simfilePath,
      packageAndTypePrepared: resealed,
      prepared: resealed,
      projectRoot: project.directory,
      packageInput,
      typeOnlyInput,
      authority,
      lockInputs: resealed.inputs.filter((entry) => entry.kind !== "project") as (DynamicsBuildInputDescriptor & { readonly kind: "package" | "type-only" })[]
    };
  } catch (error) {
    if (project) await removeBuildTestPaths(project.directory);
    throw error;
  }
};

export const assertProjectPostPrepareMutationRejected = async (): Promise<void> => {
  const fixture = await createSyntheticMjsFixture();
  try {
    await writeFile(`${fixture.projectRoot}/systems/provider.mjs`, "export const value = 2;\n");
    await assert.rejects(
      () => createDynamicsBuildReceipt(fixture.absoluteSimfilePath, fixture.prepared),
      /prepared project descriptor mismatch/i
    );
  } finally {
    await removeBuildTestPaths(fixture.projectRoot);
  }
};

export const assertPackagePostPrepareMutationRejected = async (): Promise<void> => {
  const fixture = await createPackageAndTypeFixture();
  try {
    await writeFile(`${fixture.projectRoot}/node_modules/fixture-pkg/index.ts`, "export const fixture = 12;\n");
    await assert.rejects(
      () => createDynamicsBuildReceipt(fixture.absoluteSimfilePath, fixture.prepared),
      /missing package lock evidence|claim mismatch|package claim|source hash mismatch/i
    );
  } finally {
    await removeBuildTestPaths(fixture.projectRoot);
  }
};

export const assertTypeOnlyPostPrepareMutationRejected = async (): Promise<void> => {
  const fixture = await createPackageAndTypeFixture();
  try {
    const typeOnlyInput = fixture.prepared.inputs.find((entry) => entry.kind === "type-only");
    assert.ok(typeOnlyInput);
    if (!typeOnlyInput) return;
    const corrupt = reSealPrepared(fixture.prepared, fixture.prepared.inputs.map((entry) => entry.kind === "type-only"
      ? { ...typeOnlyInput, files: [{ ...typeOnlyInput.files[0]!, sha256: "0".repeat(64) }, ...typeOnlyInput.files.slice(1)] }
      : entry
    ));
    await assert.rejects(
      () => createDynamicsBuildReceipt(fixture.absoluteSimfilePath, corrupt),
      /type-only|source hash mismatch|claim/i
    );
  } finally {
    await removeBuildTestPaths(fixture.projectRoot);
  }
};
