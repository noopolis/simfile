import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  rmdir
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sha256 } from "./buildIdentity.js";

const fail = (message: string): never => { throw new Error(message); };

export interface DynamicsBuildPairPaths {
  readonly artifactDirectory: string;
  readonly artifactPath: string;
  readonly dynamicsDirectory: string;
  readonly receiptPath: string;
}

export interface StagedDynamicsBuildPair {
  readonly paths: DynamicsBuildPairPaths;
  cleanup(): Promise<void>;
}

export const bytesEqual = (left: ArrayLike<number>, right: ArrayLike<number>): boolean => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

export const assertDynamicsBuildRoot = async (candidate: string, label: string): Promise<string> => {
  if (!path.isAbsolute(candidate)) fail(`${label} must be absolute`);
  if (path.resolve(candidate) !== candidate) fail(`${label} must be normalized`);
  const observed = await realpath(candidate).catch(() => fail(`${label} must be an existing directory`));
  if (observed !== candidate) fail(`${label} must not contain symlinks`);
  const metadata = await lstat(candidate);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail(`${label} must be a non-symlink directory`);
  return candidate;
};

export const dynamicsBuildPairPaths = (
  root: string,
  artifactSha256: string
): DynamicsBuildPairPaths => {
  const dynamicsDirectory = path.join(root, "dynamics");
  const artifactDirectory = path.join(dynamicsDirectory, `sha256-${artifactSha256}`);
  return {
    dynamicsDirectory,
    artifactDirectory,
    artifactPath: path.join(artifactDirectory, "provider.mjs"),
    receiptPath: path.join(dynamicsDirectory, "build-receipt.json")
  };
};

const assertDirectory = async (directory: string): Promise<void> => {
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail(`dynamics artifact path is not a regular directory: ${directory}`);
  }
};

const assertAbsent = async (fileName: string): Promise<void> => {
  try {
    await lstat(fileName);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  fail(`dynamics artifact target already exists: ${fileName}`);
};

export const assertReadonlyBuildFile = async (
  fileName: string,
  expected: readonly number[],
  expectedSha256: string,
  label: string
): Promise<void> => {
  const metadata = await lstat(fileName).catch(() => fail(`${label} is missing`));
  if (metadata.isSymbolicLink() || !metadata.isFile()) fail(`${label} must be a regular file`);
  if ((metadata.mode & 0o222) !== 0) fail(`${label} must be read-only`);
  const observed = await readFile(fileName);
  if (!bytesEqual(observed, expected)) fail(`${label} bytes mismatch`);
  if (sha256(observed) !== expectedSha256) fail(`${label} SHA-256 mismatch`);
};

const publishReadonlyFile = async (
  fileName: string,
  bytes: readonly number[],
  expectedSha256: string
): Promise<void> => {
  const temporary = path.join(path.dirname(fileName), `.${path.basename(fileName)}.${randomUUID()}.tmp`);
  let temporaryCreated = false;
  let targetCreated = false;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    temporaryCreated = true;
    await handle.writeFile(Uint8Array.from(bytes));
    await handle.sync();
    await handle.close();
    handle = undefined;
    const staged = await readFile(temporary);
    if (!bytesEqual(staged, bytes) || sha256(staged) !== expectedSha256) {
      fail(`temporary dynamics artifact verification failed: ${fileName}`);
    }

    const reservation = await open(fileName, "wx", 0o000);
    targetCreated = true;
    await reservation.close();
    await rename(temporary, fileName);
    temporaryCreated = false;
    await chmod(fileName, 0o444);
    await assertReadonlyBuildFile(fileName, bytes, expectedSha256, "persisted dynamics artifact");
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    if (temporaryCreated) await rm(temporary, { force: true }).catch(() => undefined);
    if (targetCreated) await rm(fileName, { force: true }).catch(() => undefined);
    throw error;
  }
};

export const stageDynamicsBuildPair = async (
  paths: DynamicsBuildPairPaths,
  artifactBytes: readonly number[],
  artifactSha256: string,
  receiptBytes: readonly number[],
  receiptSha256: string
): Promise<StagedDynamicsBuildPair> => {
  let dynamicsCreated = false;
  let artifactDirectoryCreated = false;
  let artifactCreated = false;
  let receiptCreated = false;
  let cleanupCompleted = false;
  let cleanupInFlight: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    if (cleanupCompleted) return Promise.resolve();
    if (cleanupInFlight) return cleanupInFlight;
    const attempt = (async (): Promise<void> => {
      if (receiptCreated) {
        await rm(paths.receiptPath, { force: true });
        receiptCreated = false;
      }
      if (artifactCreated) {
        await rm(paths.artifactPath, { force: true });
        artifactCreated = false;
      }
      if (artifactDirectoryCreated) {
        await rmdir(paths.artifactDirectory);
        artifactDirectoryCreated = false;
      }
      if (dynamicsCreated) {
        await rmdir(paths.dynamicsDirectory);
        dynamicsCreated = false;
      }
      cleanupCompleted = true;
    })();
    cleanupInFlight = attempt;
    attempt.then(
      () => { if (cleanupInFlight === attempt) cleanupInFlight = undefined; },
      () => { if (cleanupInFlight === attempt) cleanupInFlight = undefined; }
    );
    return attempt;
  };

  try {
    try {
      await mkdir(paths.dynamicsDirectory, { mode: 0o700 });
      dynamicsCreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await assertDirectory(paths.dynamicsDirectory);
    }
    await assertAbsent(paths.receiptPath);
    await mkdir(paths.artifactDirectory, { mode: 0o700 });
    artifactDirectoryCreated = true;
    await publishReadonlyFile(paths.artifactPath, artifactBytes, artifactSha256);
    artifactCreated = true;
    await publishReadonlyFile(paths.receiptPath, receiptBytes, receiptSha256);
    receiptCreated = true;
    return { paths, cleanup };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "dynamics artifact staging and owned cleanup both failed"
      );
    }
    throw error;
  }
};

export const assertDynamicsBuildPairDirectories = async (
  paths: DynamicsBuildPairPaths
): Promise<void> => {
  await assertDirectory(paths.dynamicsDirectory);
  await assertDirectory(paths.artifactDirectory);
};
