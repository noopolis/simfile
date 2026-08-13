import { createRequire } from "node:module";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { compareUtf16, deepFreeze } from "./buildIdentity.js";
import {
  asBoolean,
  asDefined,
  asDependencyMap,
  asObject,
  asString,
  assertPortablePath,
  assertRegularDirectory,
  assertRegularFile,
  compareMaps,
  parseJson,
  readPackageIdentity,
  readPackageName,
  readRegularFile,
  sha256,
  toPortable
} from "./buildReceiptLockPath.js";
import type { DynamicsReceiptSelfLinkEntry } from "./buildReceiptSelfLinks.js";

const fail = (message: string): never => { throw new Error(message); };

const isNodeModulesPath = (value: string): boolean => value === "" || value.startsWith("node_modules/");

export interface LockPackageEntry {
  readonly path: string;
  readonly version: string;
  readonly name: string | null;
}

export interface LockAuthorityParse {
  readonly rootName: string;
  readonly rootVersion: string;
  readonly packageEntries: readonly LockPackageEntry[];
  readonly lockPath: string;
  readonly lockDigest: string;
  readonly rootPackageSha256: string;
  readonly rootDependencies: {
    readonly dependencies: Readonly<Record<string, string>>;
    readonly devDependencies: Readonly<Record<string, string>>;
    readonly optionalDependencies: Readonly<Record<string, string>>;
    readonly peerDependencies: Readonly<Record<string, string>>;
  };
}

export interface DynamicsReceiptLockToolIdentity {
  readonly name: "esbuild" | "typescript";
  readonly version: string;
  readonly manifest_sha256: string;
  readonly lock_entry_path: string;
  readonly lock_sha256: string;
}

type LockAuthorityKind = "toolchain" | "project";
interface LockAuthorityBase {
  readonly kind: LockAuthorityKind;
  readonly absoluteRoot: string;
  readonly absoluteLockRoot: string;
  readonly absoluteLockPath: string;
  readonly absoluteLockRealPath: string;
  readonly lock_sha256: string;
  readonly root_package_name: string;
  readonly root_package_version: string;
  readonly root_package_sha256: string;
  readonly packageEntries: readonly LockPackageEntry[];
  readonly toolIdentities: readonly DynamicsReceiptLockToolIdentity[] | null;
}

export type DynamicsReceiptLockToolchainAuthority = Readonly<LockAuthorityBase & { readonly kind: "toolchain"; readonly toolIdentities: readonly DynamicsReceiptLockToolIdentity[] }>;
export type DynamicsReceiptLockProjectAuthority = Readonly<LockAuthorityBase & {
  readonly kind: "project";
  readonly toolIdentities: null;
  readonly selfLinkEntries: readonly DynamicsReceiptSelfLinkEntry[];
}>;

type LockAuthority = DynamicsReceiptLockToolchainAuthority | DynamicsReceiptLockProjectAuthority;

const asEntry = (value: unknown, lockPath: string, entryPath: string): LockPackageEntry => {
  const json = asObject(value, `${lockPath}:packages[${JSON.stringify(entryPath)}]`);
  if (entryPath !== "") {
    assertPortablePath(entryPath, `lock entry ${entryPath}`);
    if (!isNodeModulesPath(entryPath)) fail(`invalid lock entry path: ${entryPath}`);
  }

  if (asBoolean(json.link, `${lockPath}:packages[${JSON.stringify(entryPath)}].link`) === true) {
    fail(`workspace lock entry rejected: ${entryPath}`);
  }

  const entryName = Object.prototype.hasOwnProperty.call(json, "name")
    ? asString(json.name, `${lockPath}:packages[${JSON.stringify(entryPath)}].name`)
    : undefined;
  const entryVersion = asString(json.version, `${lockPath}:packages[${JSON.stringify(entryPath)}].version`);
  return deepFreeze({ path: entryPath, version: entryVersion, name: entryName ?? null });
};

/** Parses the exact package and lock bytes retained by a caller-owned snapshot. */
export const parseLockAuthorityBytes = (
  root: string,
  packageJsonRaw: Uint8Array,
  lockRaw: Uint8Array,
): LockAuthorityParse => {
  const packageJsonPath = path.join(root, "package.json");
  const lockPath = path.join(root, "package-lock.json");

  const packageJson = parseJson(new TextDecoder("utf-8", { fatal: true }).decode(packageJsonRaw), packageJsonPath);
  const rootName = asString(packageJson.name, `${packageJsonPath}:name`);
  const rootVersion = asString(packageJson.version, `${packageJsonPath}:version`);
  const packageJsonSha = sha256(packageJsonRaw);
  const packageJsonDeps = {
    dependencies: asDependencyMap(packageJson.dependencies, `${packageJsonPath}:dependencies`),
    devDependencies: asDependencyMap(packageJson.devDependencies, `${packageJsonPath}:devDependencies`),
    optionalDependencies: asDependencyMap(packageJson.optionalDependencies, `${packageJsonPath}:optionalDependencies`),
    peerDependencies: asDependencyMap(packageJson.peerDependencies, `${packageJsonPath}:peerDependencies`)
  };

  const lock = parseJson(new TextDecoder("utf-8", { fatal: true }).decode(lockRaw), lockPath);
  if (lock.lockfileVersion !== 3) fail(`unsupported npm lockfile version: ${lockPath}`);

  const lockName = asString(lock.name, `${lockPath}:name`);
  const lockVersion = asString(lock.version, `${lockPath}:version`);
  if (lockName !== rootName || lockVersion !== rootVersion) fail(`top-level lock mismatch: ${lockPath}`);

  const packageEntriesRaw = asObject(lock.packages, `${lockPath}:packages`);
  if (!("" in packageEntriesRaw)) fail(`invalid package-lock packages entry: ${lockPath}`);

  const rootEntry = asObject(packageEntriesRaw[""], `${lockPath}:packages[\"\"]`);
  const rootEntryName = asString(rootEntry.name, `${lockPath}:packages[\"\"].name`);
  const rootEntryVersion = asString(rootEntry.version, `${lockPath}:packages[\"\"].version`);
  if (rootEntryName !== rootName || rootEntryVersion !== rootVersion) fail(`wrong-root lock data: ${lockPath}`);

  const lockDependencyMaps = {
    dependencies: asDependencyMap(rootEntry.dependencies, `${lockPath}:packages[\"\"].dependencies`),
    devDependencies: asDependencyMap(rootEntry.devDependencies, `${lockPath}:packages[\"\"].devDependencies`),
    optionalDependencies: asDependencyMap(rootEntry.optionalDependencies, `${lockPath}:packages[\"\"].optionalDependencies`),
    peerDependencies: asDependencyMap(rootEntry.peerDependencies, `${lockPath}:packages[\"\"].peerDependencies`)
  };

  compareMaps(packageJsonDeps.dependencies, lockDependencyMaps.dependencies, "dependencies");
  compareMaps(packageJsonDeps.devDependencies, lockDependencyMaps.devDependencies, "devDependencies");
  compareMaps(packageJsonDeps.optionalDependencies, lockDependencyMaps.optionalDependencies, "optionalDependencies");
  compareMaps(packageJsonDeps.peerDependencies, lockDependencyMaps.peerDependencies, "peerDependencies");

  const packageEntries: Array<LockPackageEntry> = [];
  for (const entryPath of Object.keys(packageEntriesRaw).sort(compareUtf16)) {
    if (entryPath === "") continue;
    packageEntries.push(asEntry(packageEntriesRaw[entryPath], lockPath, entryPath));
  }

  return deepFreeze({
    rootName,
    rootVersion,
    packageEntries: deepFreeze(packageEntries),
    lockPath,
    lockDigest: sha256(lockRaw),
    rootPackageSha256: packageJsonSha,
    rootDependencies: {
      dependencies: packageJsonDeps.dependencies,
      devDependencies: packageJsonDeps.devDependencies,
      optionalDependencies: packageJsonDeps.optionalDependencies,
      peerDependencies: packageJsonDeps.peerDependencies
    }
  });
};

export const readLockAuthorityParse = async (root: string): Promise<LockAuthorityParse> =>
  parseLockAuthorityBytes(
    root,
    await readRegularFile(path.join(root, "package.json"), path.join(root, "package.json")),
    await readRegularFile(path.join(root, "package-lock.json"), path.join(root, "package-lock.json")),
  );

interface ResolvedTool {
  readonly name: "esbuild" | "typescript";
  readonly version: string;
  readonly packageRootRealPath: string;
  readonly manifestRealPath: string;
  readonly manifestSha256: string;
}

const relativeToolPath = (root: string, tool: ResolvedTool): string => {
  const rel = path.relative(root, tool.packageRootRealPath);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) fail(`tool package root mismatch: ${tool.name}`);
  return toPortable(rel);
};

const resolveToolFromAnchor = async (
  require: NodeRequire,
  name: "esbuild" | "typescript",
  expectedVersion: string
): Promise<ResolvedTool> => {
  const packageEntryPath = require.resolve(name);
  const packageManifestPath = require.resolve(`${name}/package.json`);
  const absoluteManifestPath = await assertRegularFile(packageManifestPath, `${name}/package.json`);
  const absoluteEntryPath = await assertRegularFile(packageEntryPath, `${name}`);

  const entryRelative = path.relative(path.dirname(absoluteManifestPath), absoluteEntryPath);
  if (entryRelative === "" || entryRelative.startsWith("..") || path.isAbsolute(entryRelative)) {
    fail(`tool package path mismatch: ${name}`);
  }

  const manifest = await readPackageIdentity(absoluteManifestPath);
  if (manifest.name !== name || manifest.version !== expectedVersion) fail(`toolchain installed ${name} mismatch`);

  const manifestRealPath = await realpath(absoluteManifestPath);
  return {
    name,
    version: manifest.version,
    packageRootRealPath: await realpath(path.dirname(manifestRealPath)),
    manifestRealPath,
    manifestSha256: manifest.sha256
  };
};

const readToolIdentity = (
  root: string,
  tool: ResolvedTool,
  entryPath: string,
  lockDigest: string
): DynamicsReceiptLockToolIdentity => {
  const relativeManifest = toPortable(path.relative(root, tool.manifestRealPath));
  if (relativeManifest !== `${entryPath}/package.json`) {
    fail(`toolchain manifest mismatch: ${tool.name}`);
  }
  return {
    name: tool.name,
    version: tool.version,
    manifest_sha256: tool.manifestSha256,
    lock_entry_path: entryPath,
    lock_sha256: lockDigest
  };
};

const resolveToolchainLockAuthority = async (
  root: string,
  esbuild: ResolvedTool,
  typescript: ResolvedTool
): Promise<DynamicsReceiptLockToolchainAuthority> => {
  const parsed = await readLockAuthorityParse(root);
  if (parsed.rootName !== "simfile") fail("toolchain lock root mismatch");

  const rootDependency = {
    ...parsed.rootDependencies.dependencies,
    ...parsed.rootDependencies.devDependencies,
    ...parsed.rootDependencies.optionalDependencies,
    ...parsed.rootDependencies.peerDependencies
  };
  if (rootDependency.esbuild !== esbuild.version) fail("toolchain root esbuild pin mismatch");
  if (rootDependency.typescript !== typescript.version) fail("toolchain root typescript pin mismatch");

  const esbuildEntryPath = relativeToolPath(root, esbuild);
  const typescriptEntryPath = relativeToolPath(root, typescript);

  const esbuildPackagePath = await assertRegularDirectory(path.join(root, esbuildEntryPath), `toolchain lock entry ${esbuild.name}`);
  const typescriptPackagePath = await assertRegularDirectory(path.join(root, typescriptEntryPath), `toolchain lock entry ${typescript.name}`);
  if (await realpath(esbuildPackagePath) !== esbuild.packageRootRealPath) fail(`toolchain lock package mismatch: ${esbuild.name}`);
  if (await realpath(typescriptPackagePath) !== typescript.packageRootRealPath) fail(`toolchain lock package mismatch: ${typescript.name}`);

  const esbuildEntry = asDefined(parsed.packageEntries.find((entry) => entry.path === esbuildEntryPath), `toolchain lock entry mismatch: ${esbuild.name}`);
  const typescriptEntry = asDefined(
    parsed.packageEntries.find((entry) => entry.path === typescriptEntryPath),
    `toolchain lock entry mismatch: ${typescript.name}`
  );
  if (esbuildEntry.version !== esbuild.version) fail(`toolchain lock entry esbuild mismatch`);
  if (typescriptEntry.version !== typescript.version) fail(`toolchain lock entry typescript mismatch`);
  if (esbuildEntry.name !== null && esbuildEntry.name !== esbuild.name) fail(`toolchain lock entry name mismatch: ${esbuild.name}`);
  if (typescriptEntry.name !== null && typescriptEntry.name !== typescript.name) fail(`toolchain lock entry name mismatch: ${typescript.name}`);

  return deepFreeze({
    kind: "toolchain",
    absoluteRoot: root,
    absoluteLockRoot: root,
    absoluteLockPath: parsed.lockPath,
    absoluteLockRealPath: await realpath(parsed.lockPath),
    lock_sha256: parsed.lockDigest,
    root_package_name: parsed.rootName,
    root_package_version: parsed.rootVersion,
    root_package_sha256: parsed.rootPackageSha256,
    packageEntries: parsed.packageEntries,
    toolIdentities: deepFreeze([
      readToolIdentity(root, esbuild, esbuildEntry.path, parsed.lockDigest),
      readToolIdentity(root, typescript, typescriptEntry.path, parsed.lockDigest)
    ])
  });
};

const existsRegularFile = async (filePath: string, label: string): Promise<boolean> => {
  try {
    const entry = await lstat(filePath);
    if (entry.isSymbolicLink()) fail(`forbidden symlink file: ${label}`);
    if (!entry.isFile()) fail(`non-regular file: ${label}`);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const hasPair = async (root: string): Promise<{ hasPackageJson: boolean; hasLockFile: boolean }> => ({
  hasPackageJson: await existsRegularFile(path.join(root, "package.json"), `${root}/package.json`),
  hasLockFile: await existsRegularFile(path.join(root, "package-lock.json"), `${root}/package-lock.json`)
});

const intersectCommonAncestors = (left: string, right: string): string[] => {
  const rightAncestors = new Set<string>();
  for (let root = right; ; root = path.dirname(root)) {
    rightAncestors.add(root);
    const next = path.dirname(root);
    if (next === root) break;
  }
  const output: string[] = [];
  for (let root = left; ; root = path.dirname(root)) {
    if (rightAncestors.has(root) && !output.includes(root)) output.push(root);
    const next = path.dirname(root);
    if (next === root) break;
  }
  return output;
};

export const resolveToolchainAuthorityFromAnchor = async (
  anchorPath: string,
  esbuildVersion: string,
  typescriptVersion: string
): Promise<DynamicsReceiptLockToolchainAuthority> => {
  const require = createRequire(anchorPath);
  const esbuild = await resolveToolFromAnchor(require, "esbuild", esbuildVersion);
  const typescript = await resolveToolFromAnchor(require, "typescript", typescriptVersion);

  const candidateRoots = intersectCommonAncestors(esbuild.packageRootRealPath, typescript.packageRootRealPath);
  for (const candidateRoot of candidateRoots) {
    const { hasPackageJson, hasLockFile } = await hasPair(candidateRoot);
    if (!hasPackageJson && !hasLockFile) continue;
    if (!hasPackageJson) fail(`partial toolchain authority at ${candidateRoot}`);

    if (await readPackageName(candidateRoot) !== "simfile") continue;
    if (!hasLockFile) fail(`partial toolchain authority at ${candidateRoot}`);
    return resolveToolchainLockAuthority(candidateRoot, esbuild, typescript);
  }

  return fail("no toolchain authority found");
};
