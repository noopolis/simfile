import { createHash } from "node:crypto";
import { endianness } from "node:os";
import { lstat, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { canonicalJson, compareUtf16 } from "../dynamics/buildIdentity.js";
import { nodeModulesPackageFor, type PackageIdentity } from "../dynamics/buildPackagePolicy.js";
import { parseLockAuthorityBytes, type LockAuthorityParse } from "../dynamics/buildReceiptLockAuthority.js";
import type { DynamicsBuildSourceSnapshot } from "../dynamics/buildSourceSnapshot.js";

export interface WorldArtifactPackageRecord { readonly lock_digest: string; readonly lock_path: string; readonly manifest_digest: string; readonly name: string; readonly version: string; }
export interface WorldArtifactToolFile { readonly path: string; readonly bytes: number; readonly digest: string; }
export interface WorldArtifactToolRecord extends WorldArtifactPackageRecord {
  readonly entry: WorldArtifactToolFile; readonly closure: Readonly<{ files: readonly WorldArtifactToolFile[]; digest: string }>;
}
export interface WorldArtifactTool<T> { readonly entry: T; readonly record: WorldArtifactToolRecord; readonly version: string; }

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const byteDigest = (domain: string, bytes: Uint8Array): string => `sha256:${createHash("sha256").update(domain).update("\0").update(bytes).digest("hex")}`;
const closureDigest = (files: readonly WorldArtifactToolFile[]): string => `sha256:${createHash("sha256").update(canonicalJson({ domain: "world-artifact-tool-closure.v1", files })).digest("hex")}`;
const fail = (message: string): never => { throw new TypeError(`world artifact ${message}`); };
const inside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};
const portable = (value: string): string => {
  const result = value.split(path.sep).join("/");
  if (!/^[A-Za-z0-9@][A-Za-z0-9@._/-]*$/u.test(result) || result.includes("//") || result.includes("..")) fail("tool path is not portable");
  return result;
};

/** Rejects every symlink in the absolute source-root ancestry. */
export const assertWorldArtifactRegularAncestors = async (absolute: string): Promise<string> => {
  const root = path.resolve(absolute); const parsed = path.parse(root); const parts = root.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`source root ancestor is not regular: ${current}`);
  }
  return root;
};

/** Parses precisely the snapshot bytes whose digest and package entries are used. */
export const readWorldArtifactLock = async (
  root: string,
  snapshot: Pick<DynamicsBuildSourceSnapshot, "readBytes">,
): Promise<Readonly<{ lock: LockAuthorityParse; lockDigest: string }>> => {
  const packageBytes = await snapshot.readBytes(path.join(root, "package.json"));
  const lockBytes = await snapshot.readBytes(path.join(root, "package-lock.json"));
  return Object.freeze({ lock: parseLockAuthorityBytes(root, packageBytes, lockBytes), lockDigest: digest(lockBytes) });
};

const exactLockEntry = (lock: LockAuthorityParse, lockPath: string, identity: PackageIdentity): void => {
  const entry = lock.packageEntries.find((item) => item.path === lockPath);
  if (!entry || entry.version !== identity.version || (entry.name !== null && entry.name !== identity.name)) fail(`package lacks exact lock evidence: ${identity.name}`);
};
const authorizedInstallation = async (dependencyRoot: string, packageDirectory: string, lock: LockAuthorityParse, lockDigest: string, snapshot: DynamicsBuildSourceSnapshot): Promise<Readonly<{ installation: string; lockPath: string }>> => {
  const target = await realpath(packageDirectory); const installation = await assertWorldArtifactRegularAncestors(dependencyRoot);
  if (!inside(path.join(installation, "node_modules"), target)) fail("package link escaped authorized dependency installation");
  const external = await readWorldArtifactLock(installation, snapshot);
  const lockPath = portable(path.relative(installation, target));
  if (external.lockDigest === lockDigest && external.lock.rootName === lock.rootName && external.lock.rootVersion === lock.rootVersion && lockPath.startsWith("node_modules/")) return Object.freeze({ installation, lockPath });
  return fail("package link lacks exact authorized dependency evidence");
};

/** Validates a lexical package path and a package-manager link's exact authority. */
export const validateWorldArtifactPackage = async (root: string, dependencyRoot: string, fileName: string, lock: LockAuthorityParse, lockDigest: string, snapshot: DynamicsBuildSourceSnapshot): Promise<Readonly<{ boundary: string; fileName: string; identity: PackageIdentity; record: Omit<WorldArtifactToolRecord, "entry" | "closure"> }>> => {
  const candidate = path.resolve(fileName); const modules = path.join(root, "node_modules");
  const modulesStat = await lstat(modules); if (modulesStat.isSymbolicLink() || !modulesStat.isDirectory()) fail("node_modules is not regular");
  const identity = await nodeModulesPackageFor(candidate, snapshot.readBytes);
  if (!identity) return fail("package source has no node_modules owner");
  const ownerStat = await lstat(identity.directory); if (!ownerStat.isDirectory() && !ownerStat.isSymbolicLink()) fail("package owner is not a directory");
  const actual = await realpath(identity.directory);
  const authority = ownerStat.isSymbolicLink() || !inside(modules, actual) ? await authorizedInstallation(dependencyRoot, identity.directory, lock, lockDigest, snapshot) : Object.freeze({ installation: root, lockPath: portable(path.relative(root, identity.directory)) });
  if (!authority.lockPath.startsWith("node_modules/")) fail("package owner escaped dependency installation");
  if (inside(modules, identity.directory) && portable(path.relative(root, identity.directory)) !== authority.lockPath) fail("package link has a duplicate portable path");
  const actualStat = await lstat(actual); if (actualStat.isSymbolicLink() || !actualStat.isDirectory()) fail("package target is not regular");
  const suffix = path.relative(identity.directory, candidate);
  if (!suffix || suffix === ".." || suffix.startsWith(`..${path.sep}`) || path.isAbsolute(suffix)) fail("package source escaped exact owner");
  const targetFile = path.join(actual, suffix); const targetSuffix = path.relative(actual, targetFile).split(path.sep).filter(Boolean);
  for (let index = 0; index < targetSuffix.length; index += 1) {
    const checked = path.join(actual, ...targetSuffix.slice(0, index + 1)); const stat = await lstat(checked);
    if (stat.isSymbolicLink() || (index === targetSuffix.length - 1 ? !stat.isFile() : !stat.isDirectory())) fail(`package source is not regular: ${checked}`);
  }
  const actualIdentity = await nodeModulesPackageFor(actual, snapshot.readBytes);
  if (!actualIdentity || actualIdentity.name !== identity.name || actualIdentity.version !== identity.version) fail("package link identity is invalid");
  exactLockEntry(lock, authority.lockPath, identity);
  return Object.freeze({ boundary: identity.directory, fileName: candidate, identity, record: Object.freeze({ name: identity.name, version: identity.version, manifest_digest: `sha256:${identity.manifestSha256}`, lock_path: authority.lockPath, lock_digest: `sha256:${lockDigest}` }) });
};

const imported = (require: NodeJS.Require, fileName: string): Record<string, unknown> => {
  const cacheKey = require.resolve(fileName);
  if (cacheKey !== fileName) fail("tool entry does not have exact canonical cache authority");
  delete require.cache[cacheKey];
  const value = require(fileName) as Record<string, unknown>;
  if (!require.cache[cacheKey] || require.cache[cacheKey]?.exports !== value) fail("tool entry did not load through exact CommonJS authority");
  if (!value || typeof value !== "object") fail("tool entrypoint did not load");
  return value;
};
const selectedEsbuildNativePackage = (): string => {
  const key = `${process.platform} ${process.arch} ${endianness()}`;
  const packages: Readonly<Record<string, string>> = {
    "aix ppc64 BE": "@esbuild/aix-ppc64", "android arm LE": "@esbuild/android-arm", "android arm64 LE": "@esbuild/android-arm64", "android x64 LE": "@esbuild/android-x64", "darwin arm64 LE": "@esbuild/darwin-arm64", "darwin x64 LE": "@esbuild/darwin-x64", "freebsd arm64 LE": "@esbuild/freebsd-arm64", "freebsd x64 LE": "@esbuild/freebsd-x64", "linux arm LE": "@esbuild/linux-arm", "linux arm64 LE": "@esbuild/linux-arm64", "linux ia32 LE": "@esbuild/linux-ia32", "linux loong64 LE": "@esbuild/linux-loong64", "linux mips64el LE": "@esbuild/linux-mips64el", "linux ppc64 LE": "@esbuild/linux-ppc64", "linux riscv64 LE": "@esbuild/linux-riscv64", "linux s390x BE": "@esbuild/linux-s390x", "linux x64 LE": "@esbuild/linux-x64", "netbsd arm64 LE": "@esbuild/netbsd-arm64", "netbsd x64 LE": "@esbuild/netbsd-x64", "openbsd arm64 LE": "@esbuild/openbsd-arm64", "openbsd x64 LE": "@esbuild/openbsd-x64", "openharmony arm64 LE": "@esbuild/openharmony-arm64", "sunos x64 LE": "@esbuild/sunos-x64", "win32 arm64 LE": "@esbuild/win32-arm64", "win32 ia32 LE": "@esbuild/win32-ia32", "win32 x64 LE": "@esbuild/win32-x64"
  };
  const result = packages[key]; if (!result) fail(`esbuild platform is unsupported: ${key}`); return result;
};
type ToolFileBinding = Readonly<{ fileName: string; binding: Awaited<ReturnType<typeof validateWorldArtifactPackage>> }>;
const toolFile = async ({ fileName, binding }: ToolFileBinding, snapshot: DynamicsBuildSourceSnapshot): Promise<WorldArtifactToolFile> => {
  const bytes = await snapshot.readBytes(fileName);
  return Object.freeze({ path: portable(`${binding.record.lock_path}/${path.relative(binding.boundary, fileName)}`), bytes: bytes.byteLength, digest: byteDigest("world-artifact-tool-byte.v1", bytes) });
};
const toolRecord = async (record: Omit<WorldArtifactToolRecord, "entry" | "closure">, entry: ToolFileBinding, closureFiles: readonly ToolFileBinding[], snapshot: DynamicsBuildSourceSnapshot): Promise<WorldArtifactToolRecord> => {
  const entryFile = await toolFile(entry, snapshot);
  const files = await Promise.all(closureFiles.map((file) => toolFile(file, snapshot)));
  files.sort((left, right) => compareUtf16(left.path, right.path));
  if (files.some((file, index) => index > 0 && file.path === files[index - 1]?.path) || !files.some((file) => file.path === entryFile.path)) fail("tool closure is ambiguous");
  return Object.freeze({ ...record, entry: entryFile, closure: Object.freeze({ files: Object.freeze(files), digest: closureDigest(files) }) });
};

/** Loads the exact sealed compiler/bundler entries and esbuild's selected native executable. */
export const loadWorldArtifactTools = async (root: string, dependencyRoot: string, lock: LockAuthorityParse, lockDigest: string, snapshot: DynamicsBuildSourceSnapshot): Promise<Readonly<{ esbuild: WorldArtifactTool<Record<string, unknown>>; typescript: WorldArtifactTool<Record<string, unknown>> }>> => {
  if (process.env.ESBUILD_BINARY_PATH !== undefined) fail("esbuild environment binary substitution is rejected");
  const require = createRequire(path.join(root, "package.json"));
  const load = async (name: "esbuild" | "typescript"): Promise<WorldArtifactTool<Record<string, unknown>>> => {
    const manifest = path.join(root, "node_modules", name, "package.json"); const binding = await validateWorldArtifactPackage(root, dependencyRoot, manifest, lock, lockDigest, snapshot);
    const entryFile = require.resolve(name); const entryBinding = await validateWorldArtifactPackage(root, dependencyRoot, entryFile, lock, lockDigest, snapshot);
    if (entryBinding.identity.name !== name || await realpath(entryBinding.boundary) !== await realpath(binding.boundary)) fail(`${name} entry escaped exact identity`);
    const closureFiles: ToolFileBinding[] = [{ fileName: entryFile, binding: entryBinding }];
    if (name === "esbuild") {
      const nativeName = selectedEsbuildNativePackage(); const nativeSpecifier = `${nativeName}/${process.platform === "win32" ? "esbuild.exe" : "bin/esbuild"}`;
      const nativeFile = createRequire(entryFile).resolve(nativeSpecifier); const native = await validateWorldArtifactPackage(root, dependencyRoot, nativeFile, lock, lockDigest, snapshot);
      if (native.identity.name !== nativeName) fail("esbuild native binary escaped selected platform package"); closureFiles.push({ fileName: nativeFile, binding: native });
    }
    const record = await toolRecord(binding.record, { fileName: entryFile, binding: entryBinding }, closureFiles, snapshot);
    const loaded = imported(require, entryFile); const version = loaded.version;
    if (typeof version !== "string" || version !== binding.identity.version) fail(`${name} tool version is invalid`);
    return Object.freeze({ entry: loaded, record, version: version as string });
  };
  return Object.freeze({ esbuild: await load("esbuild"), typescript: await load("typescript") });
};

export const assertWorldArtifactMetafileInputs = (expected: ReadonlySet<string>, inputs: readonly string[], root: string): void => {
  const actual = new Set(inputs.map((item) => path.resolve(root, item)));
  if (actual.size !== expected.size || [...expected].some((item) => !actual.has(item)) || [...actual].some((item) => !expected.has(item))) fail("metafile inputs differ from preflight closure");
};
