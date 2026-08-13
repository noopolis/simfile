import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareUtf16, deepFreeze, type DynamicsBuildInputDescriptor } from "./buildIdentity.js";
import {
  buildTypeOnlyClaim,
  resolvePackageDescriptor,
  resolveProjectAuthority,
  resolveSimfileProjectRoot,
  resolveToolchainAuthorityFromAnchor,
  type DynamicsReceiptLockProjectAuthority,
  type DynamicsReceiptLockToolchainAuthority,
  type DynamicsReceiptLockToolIdentity
} from "./buildReceiptLockFiles.js";
import {
  assertCanonicalSelfLinkEntries,
  type DynamicsReceiptSelfLinkEntry
} from "./buildReceiptSelfLinks.js";

export type { DynamicsReceiptLockToolIdentity };
export type { DynamicsReceiptSelfLinkEntry };

export interface DynamicsReceiptLockPortableRecord {
  readonly manager: "npm";
  readonly lockfile_version: 3;
  readonly root_package_name: string;
  readonly root_package_version: string;
  readonly root_package_sha256: string;
  readonly lock_sha256: string;
  readonly lock_entry_path: string;
  readonly package_name: string;
  readonly package_version: string;
  readonly package_manifest_sha256: string;
  readonly source_digests: readonly Readonly<{ readonly path: string; readonly sha256: string }> [];
  readonly tool_identities: readonly DynamicsReceiptLockToolIdentity[];
}

export interface DynamicsReceiptLockDeduplicatedLock {
  readonly manager: "npm";
  readonly lockfile_version: 3;
  readonly root_package_name: string;
  readonly root_package_version: string;
  readonly root_package_sha256: string;
  readonly lock_sha256: string;
}

export interface DynamicsReceiptLockAuthority {
  readonly absoluteProjectRoot: string;
  readonly absoluteToolchainRoot: string;
  readonly toolchainAuthority: Readonly<{
    readonly absoluteLockRoot: string;
    readonly absoluteLockPath: string;
    readonly lockfile_version: 3;
    readonly root_package_name: string;
    readonly root_package_version: string;
    readonly root_package_sha256: string;
    readonly lock_sha256: string;
    readonly tool_identities: readonly DynamicsReceiptLockToolIdentity[];
  }>;
  readonly projectAuthority: Readonly<{
    readonly absoluteLockRoot: string | null;
    readonly absoluteLockPath: string | null;
    readonly lockfile_version: 3 | null;
    readonly root_package_name: string | null;
    readonly root_package_version: string | null;
    readonly root_package_sha256: string | null;
  }>;
  readonly dedupedLocks: readonly DynamicsReceiptLockDeduplicatedLock[];
  readonly dedupedLockRealpaths: readonly string[];
  readonly portableClaims: readonly DynamicsReceiptLockPortableRecord[];
  readonly selfLinkEntries: readonly DynamicsReceiptSelfLinkEntry[];
}

const fail = (message: string): never => { throw new Error(message); };

type AnyLockAuthority = DynamicsReceiptLockToolchainAuthority | DynamicsReceiptLockProjectAuthority;

export const coalesceAuthoritiesByLockRealpath = (authorities: readonly AnyLockAuthority[]): readonly AnyLockAuthority[] => {
  const map = new Map<string, AnyLockAuthority>();
  for (const authority of authorities) {
    const existing = map.get(authority.absoluteLockRealPath);
    if (existing === undefined || (existing.kind === "project" && authority.kind === "toolchain")) {
      map.set(authority.absoluteLockRealPath, authority);
    }
  }
  return Array.from(map.values());
};

const dedupeLocks = (authorities: readonly AnyLockAuthority[]): readonly DynamicsReceiptLockDeduplicatedLock[] => {
  const index = new Map<string, DynamicsReceiptLockDeduplicatedLock>();
  for (const authority of authorities) {
    if (index.has(authority.absoluteLockRealPath)) continue;
    index.set(authority.absoluteLockRealPath, {
      manager: "npm",
      lockfile_version: 3,
      root_package_name: authority.root_package_name,
      root_package_version: authority.root_package_version,
      root_package_sha256: authority.root_package_sha256,
      lock_sha256: authority.lock_sha256
    });
  }
  return deepFreeze(Array.from(index.values()).sort((left, right) => compareUtf16(left.lock_sha256, right.lock_sha256)));
};

const compareSourceDigests = (
  left: ReadonlyArray<{ readonly path: string; readonly sha256: string }>,
  right: ReadonlyArray<{ readonly path: string; readonly sha256: string }>
): number => {
  if (left.length !== right.length) return compareUtf16(String(left.length), String(right.length));
  for (let index = 0; index < left.length; index += 1) {
    const diffPath = compareUtf16(left[index].path, right[index].path);
    if (diffPath !== 0) return diffPath;
    const diffHash = compareUtf16(left[index].sha256, right[index].sha256);
    if (diffHash !== 0) return diffHash;
  }
  return 0;
};

const compareToolIdentities = (
  left: ReadonlyArray<{ readonly name: string; readonly version: string; readonly manifest_sha256: string; readonly lock_entry_path: string; readonly lock_sha256: string }>,
  right: ReadonlyArray<{ readonly name: string; readonly version: string; readonly manifest_sha256: string; readonly lock_entry_path: string; readonly lock_sha256: string }>
): number => {
  if (left.length !== right.length) return compareUtf16(String(left.length), String(right.length));
  for (let index = 0; index < left.length; index += 1) {
    const leftIdentity = left[index];
    const rightIdentity = right[index];
    const diffName = compareUtf16(leftIdentity.name, rightIdentity.name);
    if (diffName !== 0) return diffName;
    const diffVersion = compareUtf16(leftIdentity.version, rightIdentity.version);
    if (diffVersion !== 0) return diffVersion;
    const diffManifest = compareUtf16(leftIdentity.manifest_sha256, rightIdentity.manifest_sha256);
    if (diffManifest !== 0) return diffManifest;
    const diffEntry = compareUtf16(leftIdentity.lock_entry_path, rightIdentity.lock_entry_path);
    if (diffEntry !== 0) return diffEntry;
    const diffLock = compareUtf16(leftIdentity.lock_sha256, rightIdentity.lock_sha256);
    if (diffLock !== 0) return diffLock;
  }
  return 0;
};

export const compareDynamicsReceiptLockPortableRecords = (
  left: DynamicsReceiptLockPortableRecord,
  right: DynamicsReceiptLockPortableRecord
): number => {
  const diffManager = compareUtf16(left.manager, right.manager);
  if (diffManager !== 0) return diffManager;

  const diffLockVersion = compareUtf16(String(left.lockfile_version), String(right.lockfile_version));
  if (diffLockVersion !== 0) return diffLockVersion;

  const diffRootName = compareUtf16(left.root_package_name, right.root_package_name);
  if (diffRootName !== 0) return diffRootName;

  const diffRootVersion = compareUtf16(left.root_package_version, right.root_package_version);
  if (diffRootVersion !== 0) return diffRootVersion;

  const diffRootManifest = compareUtf16(left.root_package_sha256, right.root_package_sha256);
  if (diffRootManifest !== 0) return diffRootManifest;

  const diffLock = compareUtf16(left.lock_sha256, right.lock_sha256);
  if (diffLock !== 0) return diffLock;

  const diffEntry = compareUtf16(left.lock_entry_path, right.lock_entry_path);
  if (diffEntry !== 0) return diffEntry;

  const diffPackageName = compareUtf16(left.package_name, right.package_name);
  if (diffPackageName !== 0) return diffPackageName;

  const diffPackageVersion = compareUtf16(left.package_version, right.package_version);
  if (diffPackageVersion !== 0) return diffPackageVersion;

  const diffPackageManifest = compareUtf16(left.package_manifest_sha256, right.package_manifest_sha256);
  if (diffPackageManifest !== 0) return diffPackageManifest;

  const diffSource = compareSourceDigests(left.source_digests, right.source_digests);
  if (diffSource !== 0) return diffSource;

  return compareToolIdentities(left.tool_identities, right.tool_identities);
};

export const buildReceiptLock = async (
  absoluteSimfilePath: string,
  input: readonly DynamicsBuildInputDescriptor[],
  esbuildVersion: string,
  typescriptVersion: string
): Promise<DynamicsReceiptLockAuthority> => {
  if (!path.isAbsolute(absoluteSimfilePath)) fail(`simfile path must be absolute: ${absoluteSimfilePath}`);

  const absoluteProjectRoot = await resolveSimfileProjectRoot(absoluteSimfilePath);
  const toolchainAuthority = await resolveToolchainAuthorityFromAnchor(
    fileURLToPath(import.meta.url),
    esbuildVersion,
    typescriptVersion
  );
  const projectAuthority = await resolveProjectAuthority(absoluteProjectRoot, toolchainAuthority);

  const authorities: Array<AnyLockAuthority> = [toolchainAuthority];
  if (projectAuthority !== null) authorities.push(projectAuthority);
  const dedupedAuthorities = coalesceAuthoritiesByLockRealpath(authorities);

  const dedupedLocks = dedupeLocks(dedupedAuthorities);
  const dedupedLockRealpaths = deepFreeze(dedupedAuthorities.map((authority) => authority.absoluteLockRealPath).sort(compareUtf16));

  const portableClaims: DynamicsReceiptLockPortableRecord[] = [];
  for (const descriptor of input) {
    if (descriptor.kind === "package") {
      const match = await resolvePackageDescriptor(descriptor, dedupedAuthorities);
      portableClaims.push(deepFreeze({
        manager: "npm",
        lockfile_version: 3,
        root_package_name: match.authority.root_package_name,
        root_package_version: match.authority.root_package_version,
        root_package_sha256: match.authority.root_package_sha256,
        lock_sha256: match.authority.lock_sha256,
        lock_entry_path: match.lockEntryPath,
        package_name: descriptor.package_name,
        package_version: descriptor.package_version,
        package_manifest_sha256: descriptor.manifest_sha256,
        source_digests: deepFreeze([{ path: `./${descriptor.package_path.slice(2)}`, sha256: descriptor.sha256 }]),
        tool_identities: deepFreeze([])
      }));
      continue;
    }

    if (descriptor.kind === "type-only") {
      const claim = await buildTypeOnlyClaim(descriptor, toolchainAuthority);
      portableClaims.push(deepFreeze(claim as DynamicsReceiptLockPortableRecord));
      continue;
    }

    fail("unsupported descriptor kind: project");
  }

  const sortedClaims = [...portableClaims].sort(compareDynamicsReceiptLockPortableRecords);
  const selfLinkEntries = assertCanonicalSelfLinkEntries(projectAuthority?.selfLinkEntries ?? []);

  return deepFreeze({
    absoluteProjectRoot,
    absoluteToolchainRoot: toolchainAuthority.absoluteRoot,
    toolchainAuthority: deepFreeze({
      absoluteLockRoot: toolchainAuthority.absoluteLockRoot,
      absoluteLockPath: toolchainAuthority.absoluteLockPath,
      lockfile_version: 3,
      root_package_name: toolchainAuthority.root_package_name,
      root_package_version: toolchainAuthority.root_package_version,
      root_package_sha256: toolchainAuthority.root_package_sha256,
      lock_sha256: toolchainAuthority.lock_sha256,
      tool_identities: toolchainAuthority.toolIdentities
    }),
    projectAuthority: projectAuthority === null
      ? deepFreeze({
        absoluteLockRoot: null,
        absoluteLockPath: null,
        lockfile_version: null,
        root_package_name: null,
        root_package_version: null,
        root_package_sha256: null
      })
      : deepFreeze({
        absoluteLockRoot: projectAuthority.absoluteLockRoot,
        absoluteLockPath: projectAuthority.absoluteLockPath,
        lockfile_version: 3,
        root_package_name: projectAuthority.root_package_name,
        root_package_version: projectAuthority.root_package_version,
        root_package_sha256: projectAuthority.root_package_sha256
      }),
    dedupedLocks,
    dedupedLockRealpaths,
    portableClaims: deepFreeze(sortedClaims),
    selfLinkEntries
  });
};
