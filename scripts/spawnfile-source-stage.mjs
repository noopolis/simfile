import { cp, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const omittedDirectories = new Set([
  ".artifacts",
  ".git",
  ".runtime",
  ".sim",
  ".simfile-dev",
  ".spawn",
  ".spawn-dev",
  "coverage",
  "dist",
  "node_modules",
  "runs",
]);

const fail = (message) => { throw new Error(message); };

export const isOmittedSourcePath = (sourceRoot, candidate) => {
  const relative = path.relative(sourceRoot, candidate);
  return relative !== "" && relative.split(path.sep).some((part) => omittedDirectories.has(part));
};

export const inspectPhysicalSpawnfileSource = async (source) => {
  const sourceInfo = await lstat(source).catch(() => fail("--source checkout is unavailable"));
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
    return fail("--source must be a physical Spawnfile checkout directory");
  }
  const physicalPath = await realpath(source);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
  } catch (error) {
    return fail(`Unable to read ${path.join(source, "package.json")}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest?.name !== "spawnfile" || typeof manifest.version !== "string") {
    return fail("--source does not identify a Spawnfile package checkout");
  }
  return Object.freeze({ package_version: manifest.version, path: physicalPath });
};

/** Copies source into a private build staging area without changing the checkout. */
export const stagePhysicalSpawnfileSource = async (source, temporaryRoot) => {
  const origin = await inspectPhysicalSpawnfileSource(source);
  const staging = path.join(temporaryRoot, "source-stage");
  await mkdir(staging, { mode: 0o700 });
  await cp(source, staging, {
    dereference: false,
    filter: (candidate) => !isOmittedSourcePath(source, candidate),
    preserveTimestamps: false,
    recursive: true,
  });
  return Object.freeze({ origin, staging });
};
