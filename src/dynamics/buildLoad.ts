import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { type PreparedDynamicsBuild } from "./build.js";
import {
  createDynamicsBuildReceipt,
  type DynamicsBuildReceipt
} from "./buildReceipt.js";
import { canonicalJson, sha256 } from "./buildIdentity.js";
import {
  assertDynamicsBuildPairDirectories,
  assertDynamicsBuildRoot,
  assertReadonlyBuildFile,
  bytesEqual,
  dynamicsBuildPairPaths,
  stageDynamicsBuildPair,
  type DynamicsBuildPairPaths,
  type StagedDynamicsBuildPair
} from "./buildLoadFiles.js";

const fail = (message: string): never => { throw new Error(message); };

export interface PersistDynamicsBuildOptions {
  readonly absoluteSimfilePath: string;
  readonly evidenceRoot?: string;
  readonly prepared: PreparedDynamicsBuild;
  readonly receipt: unknown;
  readonly scratchRoot: string;
}

export interface DynamicsBuildArtifactEvidence {
  readonly artifactPath: string;
  readonly receiptPath: string;
}

export interface DynamicsBuildArtifactLifecycle {
  readonly artifactPath: string;
  readonly evidence?: DynamicsBuildArtifactEvidence;
  readonly receipt: DynamicsBuildReceipt;
  readonly receiptPath: string;
  cleanup(): Promise<void>;
  copyEvidence(): Promise<DynamicsBuildArtifactEvidence | undefined>;
  importArtifact(): Promise<Readonly<Record<string, unknown>>>;
  verify(): Promise<void>;
}

const assertSeparatedRoots = (scratchRoot: string, evidenceRoot: string): void => {
  const relativeEvidence = path.relative(scratchRoot, evidenceRoot);
  const relativeScratch = path.relative(evidenceRoot, scratchRoot);
  const outside = (relative: string): boolean =>
    path.isAbsolute(relative)
    || relative === ".."
    || relative.startsWith(`..${path.sep}`);
  if (
    relativeEvidence === ""
    || !outside(relativeEvidence)
    || !outside(relativeScratch)
  ) {
    fail("scratch and evidence roots must not overlap");
  }
};

const assertReceipt = async (
  absoluteSimfilePath: string,
  prepared: PreparedDynamicsBuild,
  candidate: unknown
): Promise<DynamicsBuildReceipt> => {
  const expected = await createDynamicsBuildReceipt(absoluteSimfilePath, prepared);
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    fail("dynamics build receipt is missing or malformed");
  }
  const receipt = candidate as Partial<DynamicsBuildReceipt>;
  if (!Array.isArray(receipt.receiptBytes)) fail("dynamics build receipt bytes are missing or malformed");
  const receiptBytes = receipt.receiptBytes as readonly number[];
  if (typeof receipt.receiptSha256 !== "string") fail("dynamics build receipt SHA-256 is missing or malformed");
  if (!receipt.payload || typeof receipt.payload !== "object" || Array.isArray(receipt.payload)) {
    fail("dynamics build receipt payload is missing or malformed");
  }
  if (!bytesEqual(receiptBytes, expected.receiptBytes)) fail("dynamics build receipt bytes mismatch");
  if (sha256(Uint8Array.from(receiptBytes)) !== receipt.receiptSha256) {
    fail("dynamics build receipt bytes/hash mismatch");
  }
  if (receipt.receiptSha256 !== expected.receiptSha256) fail("dynamics build receipt SHA-256 mismatch");
  if (canonicalJson(receipt.payload) !== canonicalJson(expected.payload)) {
    fail("dynamics build receipt payload mismatch");
  }
  return expected;
};

const verifyIssuedReceipt = async (
  absoluteSimfilePath: string,
  prepared: PreparedDynamicsBuild,
  receipt: DynamicsBuildReceipt
): Promise<void> => {
  const reissued = await createDynamicsBuildReceipt(absoluteSimfilePath, prepared);
  if (
    reissued.receiptSha256 !== receipt.receiptSha256
    || !bytesEqual(reissued.receiptBytes, receipt.receiptBytes)
    || canonicalJson(reissued.payload) !== canonicalJson(receipt.payload)
  ) {
    fail("dynamics build receipt no longer matches current source authority");
  }
};

const verifyPair = async (
  paths: DynamicsBuildPairPaths,
  absoluteSimfilePath: string,
  prepared: PreparedDynamicsBuild,
  receipt: DynamicsBuildReceipt
): Promise<void> => {
  await assertDynamicsBuildPairDirectories(paths);
  await assertReadonlyBuildFile(
    paths.artifactPath,
    prepared.artifactBytes,
    prepared.artifactSha256,
    "persisted dynamics artifact"
  );
  await assertReadonlyBuildFile(
    paths.receiptPath,
    receipt.receiptBytes,
    receipt.receiptSha256,
    "persisted dynamics build receipt"
  );
  await verifyIssuedReceipt(absoluteSimfilePath, prepared, receipt);
};

const writePair = (
  paths: DynamicsBuildPairPaths,
  prepared: PreparedDynamicsBuild,
  receipt: DynamicsBuildReceipt
): Promise<StagedDynamicsBuildPair> =>
  stageDynamicsBuildPair(
    paths,
    prepared.artifactBytes,
    prepared.artifactSha256,
    receipt.receiptBytes,
    receipt.receiptSha256
  );

export const persistDynamicsBuild = async (
  options: PersistDynamicsBuildOptions
): Promise<DynamicsBuildArtifactLifecycle> => {
  const scratchRoot = await assertDynamicsBuildRoot(options.scratchRoot, "dynamics scratch root");
  const evidenceRoot = options.evidenceRoot === undefined
    ? undefined
    : await assertDynamicsBuildRoot(options.evidenceRoot, "dynamics evidence root");
  if (evidenceRoot) assertSeparatedRoots(scratchRoot, evidenceRoot);
  const receipt = await assertReceipt(options.absoluteSimfilePath, options.prepared, options.receipt);
  const expectedArtifactPath = `./dynamics/sha256-${options.prepared.artifactSha256}/provider.mjs`;
  if (
    receipt.payload.artifact_sha256 !== options.prepared.artifactSha256
    || receipt.payload.artifact_path !== expectedArtifactPath
  ) {
    fail("dynamics build receipt has the wrong content address");
  }

  const scratch = dynamicsBuildPairPaths(scratchRoot, options.prepared.artifactSha256);
  const evidencePaths = evidenceRoot
    ? dynamicsBuildPairPaths(evidenceRoot, options.prepared.artifactSha256)
    : undefined;
  const scratchStage = await writePair(scratch, options.prepared, receipt);
  try {
    await verifyPair(scratch, options.absoluteSimfilePath, options.prepared, receipt);
  } catch (error) {
    await scratchStage.cleanup();
    throw error;
  }

  let copiedEvidence: DynamicsBuildArtifactEvidence | undefined;
  let cleanupCompleted = false;
  let cleanupInFlight: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    if (cleanupCompleted) return Promise.resolve();
    if (cleanupInFlight) return cleanupInFlight;
    const attempt = (async (): Promise<void> => {
      await scratchStage.cleanup();
      cleanupCompleted = true;
    })();
    cleanupInFlight = attempt;
    attempt.then(
      () => { if (cleanupInFlight === attempt) cleanupInFlight = undefined; },
      () => { if (cleanupInFlight === attempt) cleanupInFlight = undefined; }
    );
    return attempt;
  };
  const copyEvidence = async (): Promise<DynamicsBuildArtifactEvidence | undefined> => {
    if (!evidencePaths) return undefined;
    if (copiedEvidence) {
      await verifyPair(evidencePaths, options.absoluteSimfilePath, options.prepared, receipt);
      return copiedEvidence;
    }
    await verifyPair(scratch, options.absoluteSimfilePath, options.prepared, receipt);
    let evidenceStage: StagedDynamicsBuildPair | undefined;
    try {
      evidenceStage = await writePair(evidencePaths, options.prepared, receipt);
      await verifyPair(evidencePaths, options.absoluteSimfilePath, options.prepared, receipt);
    } catch (error) {
      await evidenceStage?.cleanup();
      throw error;
    }
    copiedEvidence = {
      artifactPath: evidencePaths.artifactPath,
      receiptPath: evidencePaths.receiptPath
    };
    return copiedEvidence;
  };
  const importArtifact = async (): Promise<Readonly<Record<string, unknown>>> => {
    try {
      await verifyPair(scratch, options.absoluteSimfilePath, options.prepared, receipt);
      await copyEvidence();
      const imported = await import(`${pathToFileURL(scratch.artifactPath).href}?simfile=${randomUUID()}`) as Readonly<Record<string, unknown>>;
      await verifyPair(scratch, options.absoluteSimfilePath, options.prepared, receipt);
      return imported;
    } catch (error) {
      await cleanup();
      throw error;
    }
  };

  return {
    artifactPath: scratch.artifactPath,
    get evidence() { return copiedEvidence; },
    receipt,
    receiptPath: scratch.receiptPath,
    cleanup,
    copyEvidence,
    importArtifact,
    verify: () => verifyPair(scratch, options.absoluteSimfilePath, options.prepared, receipt)
  };
};
