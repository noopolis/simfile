import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { deepFreeze, type DynamicsBuildInputDescriptor } from "./buildIdentity.js";
import {
  assertPortablePath,
  assertRegularDirectory,
  assertRegularFile,
  ensureNoSymlink,
  readPackageIdentity,
  readRegularFile,
  sha256
} from "./buildReceiptLockPath.js";
import {
  resolveToolchainAuthorityFromAnchor,
  type DynamicsReceiptLockProjectAuthority,
  type DynamicsReceiptLockToolchainAuthority,
  type DynamicsReceiptLockToolIdentity
} from "./buildReceiptLockAuthority.js";
import { readProjectLockAuthorityParse } from "./buildReceiptProjectLockAuthority.js";

const fail = (message: string): never => { throw new Error(message); };

const inferPackageNameFromPath = (entryPath: string): string | null => {
  if (!entryPath.startsWith("node_modules/")) return null;
  const segments = entryPath.slice("node_modules/".length).split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const tail = segments.at(-1);
  if (tail === undefined || tail === "node_modules") return null;
  const previous = segments.at(-2);
  if (tail.startsWith("@")) return null;
  if (previous?.startsWith("@")) return `${previous}/${tail}`;
  return tail;
};

export const resolveSimfileProjectRoot = async (absoluteSimfilePath: string): Promise<string> => {
  const simfilePath = await assertRegularFile(absoluteSimfilePath, "simfile");
  const projectRoot = path.dirname(simfilePath);
  return realpath(await assertRegularDirectory(projectRoot, "project root"));
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

export const resolveProjectAuthority = async (
  projectRoot: string,
  toolchainAuthority: DynamicsReceiptLockToolchainAuthority
): Promise<DynamicsReceiptLockProjectAuthority | null> => {
  const root = await assertRegularDirectory(projectRoot, "project root");
  const { hasPackageJson, hasLockFile } = await hasPair(root);
  if (!hasPackageJson && !hasLockFile) return null;
  if (!hasPackageJson || !hasLockFile) fail(`partial project authority at ${root}`);

  const parsed = await readProjectLockAuthorityParse(root, toolchainAuthority);
  return deepFreeze({
    kind: "project",
    absoluteRoot: root,
    absoluteLockRoot: root,
    absoluteLockPath: parsed.lockPath,
    absoluteLockRealPath: await realpath(parsed.lockPath),
    lock_sha256: parsed.lockDigest,
    root_package_name: parsed.rootName,
    root_package_version: parsed.rootVersion,
    root_package_sha256: parsed.rootPackageSha256,
    packageEntries: parsed.packageEntries,
    toolIdentities: null,
    selfLinkEntries: parsed.selfLinkEntries
  });
};

export const resolvePackageDescriptor = async (
  descriptor: Extract<DynamicsBuildInputDescriptor, { kind: "package" }>,
  authorities: readonly (DynamicsReceiptLockToolchainAuthority | DynamicsReceiptLockProjectAuthority)[]
): Promise<{ authority: DynamicsReceiptLockToolchainAuthority | DynamicsReceiptLockProjectAuthority; lockEntryPath: string }> => {
  const assertDescriptorPath = (value: string): string => {
    if (!value.startsWith("./")) fail(`path must start ./: ${value}`);
    const portable = value.slice(2);
    if (portable.length === 0) fail(`empty descriptor path: ${value}`);
    assertPortablePath(portable, `path ${value}`);
    return portable;
  };

  const sourcePath = assertDescriptorPath(descriptor.package_path);
  const matches: Array<{ authority: DynamicsReceiptLockToolchainAuthority | DynamicsReceiptLockProjectAuthority; lockEntryPath: string }> = [];

  for (const authority of authorities) {
    for (const entry of authority.packageEntries) {
      if (entry.path === "") continue;
      const inferredPackageName = inferPackageNameFromPath(entry.path);
      const lockPackageName = entry.name;
      const descriptorPackageName = descriptor.package_name;

      if (lockPackageName !== null && lockPackageName !== descriptorPackageName) continue;
      if (lockPackageName === null && inferredPackageName !== descriptorPackageName) continue;
      if (entry.version !== descriptor.package_version) continue;

      const manifestPath = path.join(authority.absoluteRoot, entry.path, "package.json");
      const manifest = await readPackageIdentity(manifestPath);
      if (
        manifest.name !== descriptorPackageName ||
        manifest.version !== descriptor.package_version ||
        manifest.sha256 !== descriptor.manifest_sha256
      ) {
        continue;
      }

      const absoluteSource = ensureNoSymlink(authority.absoluteRoot, path.join(entry.path, sourcePath), `package source ${descriptor.package_path}`);
      const rel = path.relative(authority.absoluteRoot, absoluteSource);
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) fail(`path escapes root: package source ${descriptor.package_path}`);
      const sourceSha = sha256(await readRegularFile(absoluteSource, `package source ${descriptor.package_path}`));
      if (sourceSha !== descriptor.sha256) continue;
      matches.push({ authority, lockEntryPath: entry.path });
    }
  }

  if (matches.length === 0) fail(`missing package lock evidence: ${descriptor.package_name}`);
  if (matches.length > 1) fail(`ambiguous package lock evidence: ${descriptor.package_name}`);
  return matches[0];
};

export const buildTypeOnlyClaim = async (
  descriptor: Extract<DynamicsBuildInputDescriptor, { kind: "type-only" }>,
  toolchainAuthority: DynamicsReceiptLockToolchainAuthority
) => {
  if (descriptor.surface !== "dynamics") fail(`unsupported type-only surface: ${descriptor.surface}`);
  if (descriptor.package_name !== toolchainAuthority.root_package_name) fail("type-only package mismatch");
  if (descriptor.package_version !== toolchainAuthority.root_package_version) fail("type-only version mismatch");

  const manifestPath = path.join(toolchainAuthority.absoluteRoot, "package.json");
  const manifestSha256 = sha256(await readRegularFile(manifestPath, "type-only package manifest"));
  if (manifestSha256 !== descriptor.manifest_sha256) fail("type-only manifest mismatch");
  if (descriptor.files.length === 0) fail("type-only files must be non-empty");

  const seen = new Set<string>();
  const source_digests: Array<{ path: string; sha256: string }> = [];
  const sortedFiles: string[] = [];
  for (const file of descriptor.files) {
    const assertDescriptorPath = (value: string): string => {
      if (!value.startsWith("./")) fail(`path must start ./: ${value}`);
      const portable = value.slice(2);
      if (portable.length === 0) fail(`empty descriptor path: ${value}`);
      assertPortablePath(portable, `path ${value}`);
      return portable;
    };

    const portable = assertDescriptorPath(file.path);
    if (seen.has(portable)) fail(`type-only duplicate file: ${file.path}`);
    if (source_digests.length > 0) {
      const previousPortable = sortedFiles[sortedFiles.length - 1];
      if (previousPortable >= portable) fail("type-only file list not canonical");
    }
    seen.add(portable);
    sortedFiles.push(portable);

    const absolute = ensureNoSymlink(toolchainAuthority.absoluteRoot, portable, `type-only file ${file.path}`);
    const rel = path.relative(toolchainAuthority.absoluteRoot, absolute);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) fail(`path escapes root: type-only file ${file.path}`);
    const hash = sha256(await readRegularFile(absolute, `type-only file ${file.path}`));
    if (hash !== file.sha256) fail(`type-only source hash mismatch: ${file.path}`);
    source_digests.push({ path: `./${portable}`, sha256: hash });
  }

  return deepFreeze({
    manager: "npm",
    lockfile_version: 3,
    root_package_name: toolchainAuthority.root_package_name,
    root_package_version: toolchainAuthority.root_package_version,
    root_package_sha256: toolchainAuthority.root_package_sha256,
    lock_sha256: toolchainAuthority.lock_sha256,
    lock_entry_path: "",
    package_name: descriptor.package_name,
    package_version: descriptor.package_version,
    package_manifest_sha256: descriptor.manifest_sha256,
    source_digests: deepFreeze(source_digests),
    tool_identities: toolchainAuthority.toolIdentities
  });
};

export {
  resolveToolchainAuthorityFromAnchor,
  type DynamicsReceiptLockProjectAuthority,
  type DynamicsReceiptLockToolchainAuthority,
  type DynamicsReceiptLockToolIdentity
};
