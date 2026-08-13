import { realpath } from "node:fs/promises";
import path from "node:path";
import { deepFreeze } from "./buildIdentity.js";
import {
  parseLockAuthorityBytes,
  type DynamicsReceiptLockToolchainAuthority,
  type LockAuthorityParse
} from "./buildReceiptLockAuthority.js";
import {
  asBoolean,
  asObject,
  asString,
  parseJson,
  readPackageIdentity,
  readRegularFile,
  sha256
} from "./buildReceiptLockPath.js";
import {
  assertCanonicalSelfLinkEntries,
  type DynamicsReceiptSelfLinkEntry
} from "./buildReceiptSelfLinks.js";

const fail = (message: string): never => { throw new Error(message); };
const SELF_LINK_PATH = "node_modules/simfile";

export interface ProjectLockAuthorityParse extends LockAuthorityParse {
  readonly selfLinkEntries: readonly DynamicsReceiptSelfLinkEntry[];
}

const decode = (raw: Uint8Array, filePath: string): Record<string, unknown> =>
  parseJson(new TextDecoder("utf-8", { fatal: true }).decode(raw), filePath);

const assertSelfLinkTarget = (value: string): void => {
  if (
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("://") ||
    path.isAbsolute(value)
  ) {
    fail(`invalid Simfile self-link target: ${value}`);
  }
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined || code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      fail(`invalid Simfile self-link target: ${value}`);
    }
  }
  const segments = value.split("/");
  if (segments.length === 0 || segments.some((segment) => segment === "" || segment === ".")) {
    fail(`invalid Simfile self-link target: ${value}`);
  }
  for (const segment of segments) {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(segment)) fail(`invalid Simfile self-link target: ${value}`);
  }
};

const readDeclaredSelfLink = (
  packageJson: Record<string, unknown>,
  rootEntry: Record<string, unknown>,
  resolved: string,
  packageJsonPath: string,
  lockPath: string
): void => {
  const manifestDependencies = asObject(packageJson.dependencies, `${packageJsonPath}:dependencies`);
  const lockDependencies = asObject(rootEntry.dependencies, `${lockPath}:packages[""].dependencies`);
  const expected = `file:${resolved}`;
  if (asString(manifestDependencies.simfile, `${packageJsonPath}:dependencies.simfile`) !== expected) {
    fail("project manifest Simfile self-link mismatch");
  }
  if (asString(lockDependencies.simfile, `${lockPath}:packages[""].dependencies.simfile`) !== expected) {
    fail("project lock Simfile self-link mismatch");
  }
};

const validateTargetIdentity = async (
  projectRoot: string,
  resolved: string,
  toolchainAuthority: DynamicsReceiptLockToolchainAuthority
): Promise<void> => {
  let roots: readonly [string, string];
  try {
    roots = await Promise.all([
      realpath(path.join(projectRoot, SELF_LINK_PATH)),
      realpath(path.resolve(projectRoot, resolved))
    ]);
  } catch {
    return fail("Simfile self-link target missing");
  }
  const [installedRoot, sourceRoot] = roots;
  if (installedRoot !== toolchainAuthority.absoluteRoot || sourceRoot !== toolchainAuthority.absoluteRoot) {
    fail("Simfile self-link target authority mismatch");
  }

  const identity = await readPackageIdentity(path.join(sourceRoot, "package.json"));
  if (
    identity.name !== toolchainAuthority.root_package_name ||
    identity.version !== toolchainAuthority.root_package_version ||
    identity.sha256 !== toolchainAuthority.root_package_sha256
  ) {
    fail("Simfile self-link package identity mismatch");
  }
};

const recognizeSelfLink = async (
  projectRoot: string,
  packageJson: Record<string, unknown>,
  lock: Record<string, unknown>,
  lockRaw: Uint8Array,
  toolchainAuthority: DynamicsReceiptLockToolchainAuthority
): Promise<{ sanitizedLock: Record<string, unknown>; entries: readonly DynamicsReceiptSelfLinkEntry[] }> => {
  const lockPath = path.join(projectRoot, "package-lock.json");
  const packageJsonPath = path.join(projectRoot, "package.json");
  const packages = asObject(lock.packages, `${lockPath}:packages`);
  const linkPaths = Object.keys(packages).filter((entryPath) => {
    const entry = asObject(packages[entryPath], `${lockPath}:packages[${JSON.stringify(entryPath)}]`);
    return asBoolean(entry.link, `${lockPath}:packages[${JSON.stringify(entryPath)}].link`) === true;
  });
  const sourcePaths = Object.keys(packages).filter((entryPath) =>
    entryPath !== "" && !entryPath.startsWith("node_modules/")
  );

  if (linkPaths.length === 0 && sourcePaths.length === 0) {
    return { sanitizedLock: lock, entries: deepFreeze([]) };
  }
  if (linkPaths.length !== 1 || linkPaths[0] !== SELF_LINK_PATH) fail("invalid Simfile self-link entry");

  const linkEntry = asObject(packages[SELF_LINK_PATH], `${lockPath}:packages[${JSON.stringify(SELF_LINK_PATH)}]`);
  const resolved = asString(linkEntry.resolved, `${lockPath}:packages[${JSON.stringify(SELF_LINK_PATH)}].resolved`);
  assertSelfLinkTarget(resolved);
  if (sourcePaths.length !== 1 || sourcePaths[0] !== resolved) fail("unpaired Simfile self-link source");

  const sourceEntry = asObject(packages[resolved], `${lockPath}:packages[${JSON.stringify(resolved)}]`);
  if (asBoolean(sourceEntry.link, `${lockPath}:packages[${JSON.stringify(resolved)}].link`) === true) {
    fail("Simfile self-link source must not be a link");
  }
  const sourceName = sourceEntry.name === undefined
    ? null
    : asString(sourceEntry.name, `${lockPath}:packages[${JSON.stringify(resolved)}].name`);
  if (sourceName !== null && sourceName !== "simfile") fail("Simfile self-link source name mismatch");
  const sourceVersion = asString(sourceEntry.version, `${lockPath}:packages[${JSON.stringify(resolved)}].version`);
  if (sourceVersion !== toolchainAuthority.root_package_version) fail("Simfile self-link source version mismatch");

  const rootEntry = asObject(packages[""], `${lockPath}:packages[""]`);
  readDeclaredSelfLink(packageJson, rootEntry, resolved, packageJsonPath, lockPath);
  await validateTargetIdentity(projectRoot, resolved, toolchainAuthority);

  const sanitizedPackages = { ...packages };
  delete sanitizedPackages[resolved];
  delete sanitizedPackages[SELF_LINK_PATH];
  const entry: DynamicsReceiptSelfLinkEntry = deepFreeze({
    manager: "npm",
    lockfile_version: 3,
    lock_sha256: sha256(lockRaw),
    lock_entry_path: SELF_LINK_PATH,
    package_name: "simfile",
    package_version: toolchainAuthority.root_package_version,
    package_manifest_sha256: toolchainAuthority.root_package_sha256,
    target: "toolchain_authority_root"
  });
  return {
    sanitizedLock: { ...lock, packages: sanitizedPackages },
    entries: assertCanonicalSelfLinkEntries([entry])
  };
};

export const readProjectLockAuthorityParse = async (
  projectRoot: string,
  toolchainAuthority: DynamicsReceiptLockToolchainAuthority
): Promise<ProjectLockAuthorityParse> => {
  const packageJsonPath = path.join(projectRoot, "package.json");
  const lockPath = path.join(projectRoot, "package-lock.json");
  const packageJsonRaw = await readRegularFile(packageJsonPath, packageJsonPath);
  const lockRaw = await readRegularFile(lockPath, lockPath);
  const packageJson = decode(packageJsonRaw, packageJsonPath);
  const lock = decode(lockRaw, lockPath);
  const recognized = await recognizeSelfLink(projectRoot, packageJson, lock, lockRaw, toolchainAuthority);
  const parsed = parseLockAuthorityBytes(
    projectRoot,
    packageJsonRaw,
    new TextEncoder().encode(JSON.stringify(recognized.sanitizedLock))
  );
  return deepFreeze({
    ...parsed,
    lockDigest: sha256(lockRaw),
    selfLinkEntries: recognized.entries
  });
};
