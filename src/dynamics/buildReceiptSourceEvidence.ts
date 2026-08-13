import { canonicalJson, compareUtf16, deepFreeze, type DynamicsBuildInputDescriptor } from "./buildIdentity.js";
import {
  compareDynamicsReceiptLockPortableRecords,
  type DynamicsReceiptLockDeduplicatedLock,
  type DynamicsReceiptLockPortableRecord,
  type DynamicsReceiptLockToolIdentity
} from "./buildReceiptLock.js";
import { assertPortablePath } from "./buildReceiptLockPath.js";
import { DYNAMICS_BUILD_PREPARATION_POLICY } from "./buildInput.js";

const fail = (message: string): never => { throw new Error(message); };

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PACKAGE_NAME_PATTERN = new RegExp(DYNAMICS_BUILD_PREPARATION_POLICY.package.namePattern, "u");
const PACKAGE_VERSION_PATTERN = new RegExp(DYNAMICS_BUILD_PREPARATION_POLICY.package.versionPattern, "u");
const CONTROL_TEXT_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const QUERY_FRAGMENT_PATTERN = /[?#\\]/u;
const QUERY_INJECTION_PATTERN = /(?:^|[/?#@:\\\\])(?:secret|token|credential)(?=$|[/?#@:\\\\])/iu;
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//iu;
const CREDENTIAL_PATTERN = /[^\\s:]+:[^@\\s]+@/u;

const assertString = (value: unknown, label: string): string => {
  if (typeof value !== "string") fail(`${label}: expected string`);
  const text = value as string;
  if (text.length === 0) fail(`${label}: expected non-empty string`);
  return text;
};

const assertPresent = <T>(value: T | undefined, label: string): T => {
  if (value === undefined) fail(label);
  return value!;
};

const assertRecord = (value: unknown, label: string): Readonly<Record<string, unknown>> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label}: expected object`);
  return value as Readonly<Record<string, unknown>>;
};

const assertNpmPackageName = (value: unknown, label: string): string => {
  const text = assertString(value, label);
  if (!PACKAGE_NAME_PATTERN.test(text)) fail(`${label}: invalid npm package name`);
  if (CONTROL_TEXT_PATTERN.test(text)) fail(`${label}: contains control character`);
  if (QUERY_FRAGMENT_PATTERN.test(text)) fail(`${label}: invalid npm package metadata`);
  if (SCHEME_PATTERN.test(text)) fail(`${label}: invalid npm package metadata`);
  if (CREDENTIAL_PATTERN.test(text)) fail(`${label}: invalid npm package metadata`);
  if (QUERY_INJECTION_PATTERN.test(text)) fail(`${label}: invalid npm package metadata`);
  return text;
};

const assertNpmPackageVersion = (value: unknown, label: string): string => {
  const text = assertString(value, label);
  if (!PACKAGE_VERSION_PATTERN.test(text)) fail(`${label}: invalid npm package version`);
  if (CONTROL_TEXT_PATTERN.test(text)) fail(`${label}: contains control character`);
  if (QUERY_FRAGMENT_PATTERN.test(text)) fail(`${label}: invalid npm package metadata`);
  if (SCHEME_PATTERN.test(text)) fail(`${label}: invalid npm package metadata`);
  if (CREDENTIAL_PATTERN.test(text)) fail(`${label}: invalid npm package metadata`);
  if (QUERY_INJECTION_PATTERN.test(text)) fail(`${label}: invalid npm package metadata`);
  return text;
};

const assertExactKeys = (value: unknown, label: string, expected: readonly string[]): void => {
  const record = assertRecord(value, label);
  const actual = Object.keys(record).sort(compareUtf16);
  const next = [...expected].sort(compareUtf16);
  if (actual.length !== next.length) fail(`${label}: unexpected key count`);
  for (let index = 0; index < next.length; index += 1) {
    if (actual[index] !== next[index]) fail(`${label}: unexpected field ${actual[index]}`);
  }
};

const assertSha256 = (value: unknown, label: string): string => {
  const text = assertString(value, label);
  if (!SHA256_PATTERN.test(text)) fail(`${label}: expected lowercase sha-256`);
  return text;
};

const compareToolIdentities = (
  left: Readonly<{ readonly name: string; readonly version: string; readonly manifest_sha256: string; readonly lock_entry_path: string; readonly lock_sha256: string }>,
  right: Readonly<{ readonly name: string; readonly version: string; readonly manifest_sha256: string; readonly lock_entry_path: string; readonly lock_sha256: string }>
): number => {
  const compareName = compareUtf16(left.name, right.name);
  if (compareName !== 0) return compareName;
  const compareVersion = compareUtf16(left.version, right.version);
  if (compareVersion !== 0) return compareVersion;
  const compareManifest = compareUtf16(left.manifest_sha256, right.manifest_sha256);
  if (compareManifest !== 0) return compareManifest;
  const compareEntry = compareUtf16(left.lock_entry_path, right.lock_entry_path);
  if (compareEntry !== 0) return compareEntry;
  return compareUtf16(left.lock_sha256, right.lock_sha256);
};

const assertToolIdentityShape = (tool: DynamicsReceiptLockToolIdentity, label: string): void => {
  assertExactKeys(tool, label, ["name", "version", "manifest_sha256", "lock_entry_path", "lock_sha256"]);
  if (tool.name !== "esbuild" && tool.name !== "typescript") fail(`${label}.name: expected esbuild|typescript`);
  assertNpmPackageVersion(tool.version, `${label}.version`);
  assertSha256(tool.manifest_sha256, `${label}.manifest_sha256`);
  assertPortablePath(tool.lock_entry_path, `${label}.lock_entry_path`);
  assertSha256(tool.lock_sha256, `${label}.lock_sha256`);
};

const assertSortedUniqueToolIdentities = (tools: readonly DynamicsReceiptLockToolIdentity[], label: string): void => {
  const seen = new Set<string>();
  for (let index = 0; index < tools.length; index += 1) {
    const identity = tools[index];
    if (identity === undefined) fail(`${label}[${index}]: expected tool identity`);
    assertToolIdentityShape(identity, `${label}[${index}]`);

    if (index > 0) {
      const previous = tools[index - 1];
      if (previous === undefined) continue;
      if (compareToolIdentities(previous, identity) >= 0) fail(`${label}: not total-order`);
    }

    const key = `${identity.name}\u0000${identity.version}\u0000${identity.manifest_sha256}\u0000${identity.lock_entry_path}\u0000${identity.lock_sha256}`;
    if (seen.has(key)) fail(`${label}: duplicate tool identity`);
    seen.add(key);
  }
};

const isPackageClaim = (input: DynamicsReceiptLockPortableRecord): boolean => input.tool_identities.length === 0;
const isTypeOnlyClaim = (input: DynamicsReceiptLockPortableRecord): boolean => input.tool_identities.length === 2;

const sourceGraphClaimKey = (input: DynamicsBuildInputDescriptor): string => {
  if (input.kind === "project") return `project\u0000${input.path}\u0000${input.sha256}`;
  if (input.kind === "package") return `package\u0000${input.package_name}\u0000${input.package_version}\u0000${input.package_path}\u0000${input.sha256}\u0000${input.manifest_sha256}`;
  return `type-only\u0000${input.package_name}\u0000${input.package_version}\u0000${input.manifest_sha256}\u0000${input.files
    .map((file) => `${file.path}\u0000${file.sha256}`).join("\u0001")}`;
};

const portableClaimKey = (claim: DynamicsReceiptLockPortableRecord): string => {
  const source = claim.source_digests[0];
  if (source === undefined) fail("portable claim missing source digest");
  return isPackageClaim(claim)
    ? `package\u0000${claim.package_name}\u0000${claim.package_version}\u0000${source.path}\u0000${source.sha256}\u0000${claim.package_manifest_sha256}`
    : `type-only\u0000${claim.package_name}\u0000${claim.package_version}\u0000${claim.package_manifest_sha256}\u0000${claim.source_digests
      .map((entry) => `${entry.path}\u0000${entry.sha256}`).join("\u0001")}`;
};

const assertSourceDigests = (claim: DynamicsReceiptLockPortableRecord, label: string): void => {
  if (claim.source_digests.length === 0) fail(`${label}.source_digests is empty`);
  const seen = new Set<string>();
  for (let index = 0; index < claim.source_digests.length; index += 1) {
    const source = claim.source_digests[index];
    if (source === undefined) fail(`${label}.source_digests[${index}]: expected source`);
    const canonical = `${source.path}\u0000${source.sha256}`;
    if (seen.has(canonical)) fail(`${label}.source_digests: duplicate source`);
    seen.add(canonical);
    if (index > 0) {
      const previous = claim.source_digests[index - 1];
      if (previous === undefined) continue;
      if (compareUtf16(previous.path, source.path) >= 0) fail(`${label}.source_digests: non-canonical order`);
    }

    if (!source.path.startsWith("./")) fail(`${label}.source_digests[${index}].path: expected portable relative path`);
    assertPortablePath(source.path.slice(2), `${label}.source_digests[${index}].path`);
    assertSha256(source.sha256, `${label}.source_digests[${index}].sha256`);
  }
};

export const assertCanonicalClaims = (claims: readonly DynamicsReceiptLockPortableRecord[]): readonly DynamicsReceiptLockPortableRecord[] => {
  const sorted = [...claims].sort(compareDynamicsReceiptLockPortableRecords);
  if (compareUtf16(canonicalJson(sorted), canonicalJson(claims)) !== 0) fail("portable claims are not canonical");
  return deepFreeze(sorted);
};

export const assertPortableClaims = (claims: readonly DynamicsReceiptLockPortableRecord[]): void => {
  for (const claim of claims) {
    assertExactKeys(claim, "portable claim", [
      "manager",
      "lockfile_version",
      "root_package_name",
      "root_package_version",
      "root_package_sha256",
      "lock_sha256",
      "lock_entry_path",
      "package_name",
      "package_version",
      "package_manifest_sha256",
      "source_digests",
      "tool_identities"
    ]);

    if (claim.manager !== "npm") fail("portable claim manager must be npm");
    if (claim.lockfile_version !== 3) fail("portable claim lockfile version must be 3");
    assertNpmPackageName(claim.root_package_name, "portable claim root_package_name");
    assertNpmPackageVersion(claim.root_package_version, "portable claim root_package_version");
    assertSha256(claim.root_package_sha256, "portable claim root_package_sha256");
    assertSha256(claim.lock_sha256, "portable claim lock_sha256");
    assertSha256(claim.package_manifest_sha256, "portable claim package_manifest_sha256");
    assertNpmPackageName(claim.package_name, "portable claim package_name");
    assertNpmPackageVersion(claim.package_version, "portable claim package_version");
    assertSourceDigests(claim, "portable claim");

    if (isPackageClaim(claim)) {
      if (claim.lock_entry_path === "") fail("portable package claim expected lock_entry_path");
      assertPortablePath(claim.lock_entry_path, "portable claim lock_entry_path");
      if (claim.source_digests.length !== 1) fail("portable package claim must have one source digest");
      continue;
    }

    if (!isTypeOnlyClaim(claim)) fail("portable claim has unsupported tool-identity arity");

    if (claim.lock_entry_path !== "") fail("portable type-only claim must have empty lock_entry_path");
    assertSortedUniqueToolIdentities(claim.tool_identities, "portable claim tool_identities");
  }
};

export const assertDedupedLocks = (value: readonly DynamicsReceiptLockDeduplicatedLock[]): readonly DynamicsReceiptLockDeduplicatedLock[] => {
  const seenBySha = new Set<string>();
  for (let index = 1; index < value.length; index += 1) {
    const previous = value[index - 1];
    const current = value[index];
    if (previous === undefined || current === undefined) continue;
    if (compareUtf16(previous.lock_sha256, current.lock_sha256) >= 0) {
      fail("deduped locks are not ordered by lock_sha256");
    }
  }

  const seen = new Set<string>();
  for (const lock of value) {
    if (lock.manager !== "npm") fail("deduped lock manager must be npm");
    if (lock.lockfile_version !== 3) fail("deduped lock fileversion must be 3");
    assertNpmPackageName(lock.root_package_name, "deduped lock root_package_name");
    assertNpmPackageVersion(lock.root_package_version, "deduped lock root_package_version");
    assertSha256(lock.root_package_sha256, "deduped lock root_package_sha256");
    assertSha256(lock.lock_sha256, "deduped lock lock_sha256");

    const key = `${lock.root_package_name}\u0000${lock.root_package_version}\u0000${lock.root_package_sha256}\u0000${lock.lock_sha256}`;
    if (seen.has(key)) fail(`duplicate deduped lock: ${key}`);
    seen.add(key);

    if (seenBySha.has(lock.lock_sha256)) fail(`ambiguous deduped lock sha256: ${lock.lock_sha256}`);
    seenBySha.add(lock.lock_sha256);
  }

  return deepFreeze([...value]);
};

export const assertSourceClaims = (
  sourceGraph: readonly DynamicsBuildInputDescriptor[],
  portableClaims: readonly DynamicsReceiptLockPortableRecord[],
  lockInputs: readonly (DynamicsBuildInputDescriptor & { kind: "package" | "type-only" })[],
  buildTools: readonly DynamicsReceiptLockToolIdentity[]
): void => {
  const packageClaims = new Map<string, DynamicsReceiptLockPortableRecord>();
  const typeOnlyClaims = new Map<string, DynamicsReceiptLockPortableRecord>();
  for (const claim of portableClaims) {
    if (isPackageClaim(claim)) {
      const key = portableClaimKey(claim);
      if (packageClaims.has(key)) fail(`duplicate package portable claim: ${key}`);
      packageClaims.set(key, claim);
      continue;
    }
    if (isTypeOnlyClaim(claim)) {
      const key = portableClaimKey(claim);
      if (typeOnlyClaims.has(key)) fail(`duplicate type-only portable claim: ${key}`);
      typeOnlyClaims.set(key, claim);
      continue;
    }
    fail("portable claim has unsupported tool-identity arity");
  }

  let packageCount = 0;
  let typeOnlyCount = 0;
  for (const input of lockInputs) {
    if (input.kind === "package") packageCount += 1;
    if (input.kind === "type-only") typeOnlyCount += 1;

    const key = sourceGraphClaimKey(input);
    if (input.kind === "package") {
      const claim = assertPresent(packageClaims.get(key), `missing claim for prepared descriptor: ${key}`);

      packageClaims.delete(key);
      if (claim.source_digests.length !== 1) fail(`package claim should have one source: ${key}`);
      const source = claim.source_digests[0];
      if (source === undefined || source.path !== `./${input.package_path.slice(2)}` || source.sha256 !== input.sha256) {
        fail(`package claim mismatch: ${key}`);
      }
      if (claim.package_name !== input.package_name || claim.package_version !== input.package_version) {
        fail(`package claim identity mismatch: ${key}`);
      }
      if (claim.package_manifest_sha256 !== input.manifest_sha256) {
        fail(`package manifest mismatch: ${key}`);
      }
      if (claim.tool_identities.length !== 0) fail(`package claim should not include issuer tool identities: ${key}`);
      continue;
    }

    const claim = assertPresent(typeOnlyClaims.get(key), `missing claim for prepared descriptor: ${key}`);

    typeOnlyClaims.delete(key);

    if (claim.tool_identities.length !== 2) {
      fail(`type-only claim should include two issuer tool identities: ${key}`);
    }
    if (canonicalJson(claim.tool_identities) !== canonicalJson(buildTools)) {
      fail(`type-only claim tool identities mismatch: ${key}`);
    }
    if (claim.source_digests.length !== input.files.length) {
      fail(`type-only claim source count mismatch: ${key}`);
    }
    for (let index = 0; index < input.files.length; index += 1) {
      const expected = input.files[index];
      const observed = claim.source_digests[index];
      if (expected === undefined || observed === undefined || observed.path !== expected.path || observed.sha256 !== expected.sha256) {
        fail(`type-only claim source mismatch: ${key}`);
      }
    }
    if (
      claim.package_name !== input.package_name
      || claim.package_version !== input.package_version
      || claim.package_manifest_sha256 !== input.manifest_sha256
    ) {
      fail(`type-only claim identity mismatch: ${key}`);
    }
  }

  if (packageClaims.size !== 0) fail(`uncovered package claim: ${[...packageClaims.keys()].join(",")}`);
  if (typeOnlyClaims.size !== 0) fail(`uncovered type-only claim: ${[...typeOnlyClaims.keys()].join(",")}`);

  if (sourceGraph.filter((entry) => entry.kind === "package").length !== packageCount) {
    fail("package descriptor count mismatch");
  }
  if (sourceGraph.filter((entry) => entry.kind === "type-only").length !== typeOnlyCount) {
    fail("type-only descriptor count mismatch");
  }
}

export const assertToolset = (
  buildTools: readonly DynamicsReceiptLockToolIdentity[],
  normalizedEsbuild: string,
  normalizedTypescript: string
): readonly DynamicsReceiptLockToolIdentity[] => {
  if (buildTools.length !== 2) fail("expected exactly two tool identities");
  assertSortedUniqueToolIdentities(buildTools, "prepared.buildTools");

  let esbuild: DynamicsReceiptLockToolIdentity | undefined;
  let typescript: DynamicsReceiptLockToolIdentity | undefined;
  for (const tool of buildTools) {
    if (tool.name === "esbuild") esbuild = tool;
    else if (tool.name === "typescript") typescript = tool;
  }

  const esbuildTool = assertPresent(esbuild, "expected tool identity for esbuild");
  const typescriptTool = assertPresent(typescript, "expected tool identity for typescript");
  if (esbuildTool.version !== normalizedEsbuild) fail("esbuild version mismatch between closure and toolchain");
  if (typescriptTool.version !== normalizedTypescript) fail("typescript version mismatch between closure and toolchain");

  const seen = new Set<string>();
  for (const tool of buildTools) {
    const key = `${tool.name}\u0000${tool.version}\u0000${tool.manifest_sha256}\u0000${tool.lock_entry_path}\u0000${tool.lock_sha256}`;
    if (seen.has(key)) fail("tool identity duplicate");
    seen.add(key);
  }

  return deepFreeze([...buildTools]);
};
