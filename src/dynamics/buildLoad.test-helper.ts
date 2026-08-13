import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type TestContext } from "node:test";
import { type PreparedDynamicsBuild } from "./build.js";
import { createDynamicsBuildReceipt, type DynamicsBuildReceipt } from "./buildReceipt.js";
import { createSyntheticMjsFixture } from "./buildReceipt.test-helper.js";
import { sha256 } from "./buildIdentity.js";
import { removeBuildTestPaths } from "./buildTestSupport.test-helper.js";
import {
  persistDynamicsBuild,
  type DynamicsBuildArtifactLifecycle,
  type PersistDynamicsBuildOptions
} from "./buildLoad.js";

export interface BuildLoadFixture {
  readonly absoluteSimfilePath: string;
  readonly evidenceRoot: string;
  readonly prepared: PreparedDynamicsBuild;
  readonly projectRoot: string;
  readonly receipt: DynamicsBuildReceipt;
  readonly scratchRoot: string;
  readonly sourcePath: string;
  persist(overrides?: Partial<PersistDynamicsBuildOptions>): Promise<DynamicsBuildArtifactLifecycle>;
}

export const preparedWithBody = (
  prepared: PreparedDynamicsBuild,
  body: string
): PreparedDynamicsBuild => {
  const header = `/* simfile-dynamics-closure-sha256:${prepared.closureSha256} */\n`;
  const artifactBytes = new TextEncoder().encode(`${header}${body}`);
  return {
    ...prepared,
    artifactBytes: Array.from(artifactBytes),
    artifactSha256: sha256(artifactBytes)
  };
};

export const createBuildLoadFixture = async (
  testContext: TestContext,
  artifactBody?: string
): Promise<BuildLoadFixture> => {
  const synthetic = await createSyntheticMjsFixture();
  const roots: string[] = [];
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })));
    await removeBuildTestPaths(synthetic.projectRoot);
    cleaned = true;
  };
  testContext.after(cleanup);
  let scratchRoot: string;
  let evidenceRoot: string;
  let prepared: PreparedDynamicsBuild;
  let receipt: DynamicsBuildReceipt;
  try {
    const temporaryRoot = await realpath(os.tmpdir());
    scratchRoot = await mkdtemp(path.join(temporaryRoot, "simfile-build-load-scratch-"));
    roots.push(scratchRoot);
    evidenceRoot = await mkdtemp(path.join(temporaryRoot, "simfile-build-load-evidence-"));
    roots.push(evidenceRoot);
    prepared = artifactBody === undefined
      ? synthetic.prepared
      : preparedWithBody(synthetic.prepared, artifactBody);
    receipt = await createDynamicsBuildReceipt(synthetic.absoluteSimfilePath, prepared);
  } catch (error) {
    await cleanup();
    throw error;
  }
  const defaults: PersistDynamicsBuildOptions = {
    absoluteSimfilePath: synthetic.absoluteSimfilePath,
    evidenceRoot,
    prepared,
    receipt,
    scratchRoot
  };
  return {
    absoluteSimfilePath: synthetic.absoluteSimfilePath,
    evidenceRoot,
    prepared,
    projectRoot: synthetic.projectRoot,
    receipt,
    scratchRoot,
    sourcePath: path.join(synthetic.projectRoot, "systems", "provider.mjs"),
    persist: (overrides = {}) => persistDynamicsBuild({ ...defaults, ...overrides })
  };
};
