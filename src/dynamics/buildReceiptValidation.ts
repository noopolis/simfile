import {
  canonicalJson,
  compareUtf16,
  deepFreeze,
  sha256,
  type DynamicsBuildInputDescriptor
} from "./buildIdentity.js";
import { DYNAMICS_BUILD_CONTRACT, DYNAMICS_BUILD_PREPARATION_POLICY } from "./buildInput.js";
import { DYNAMICS_STATIC_CLOSURE_POLICY } from "./buildStaticPolicy.js";
import { assertPortablePath } from "./buildReceiptLockPath.js";
import { type PreparedDynamicsBuild } from "./build.js";

const fail = (message: string): never => { throw new Error(message); };

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const NODE_BUILTINS = new Set<string>(DYNAMICS_BUILD_PREPARATION_POLICY.nodeBuiltins);
const PACKAGE_NAME_PATTERN = new RegExp(DYNAMICS_BUILD_PREPARATION_POLICY.package.namePattern, "u");
const PACKAGE_VERSION_PATTERN = new RegExp(DYNAMICS_BUILD_PREPARATION_POLICY.package.versionPattern, "u");
const CONTROL_TEXT_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const QUERY_FRAGMENT_PATTERN = /[?#\\]/u;
const QUERY_INJECTION_PATTERN = /(?:^|[/?#@:\\\\])(?:secret|token|credential)(?=$|[/?#@:\\\\])/iu;
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//iu;
const CREDENTIAL_PATTERN = /[^\\s:]+:[^@\\s]+@/u;

export interface NormalizedPreparedBuild {
  readonly artifactBytes: readonly number[];
  readonly artifactSha256: string;
  readonly closureSha256: string;
  readonly inputs: readonly DynamicsBuildInputDescriptor[];
  readonly nodeBuiltins: readonly string[];
  readonly closure: {
    readonly entry: string;
    readonly esbuildVersion: string;
    readonly inputs: readonly DynamicsBuildInputDescriptor[];
    readonly preparedTypecheckMode: "none" | "typescript";
    readonly typescriptVersion: string;
    readonly usedNodeBuiltins: readonly string[];
  };
}

export const closurePreparationPolicy = deepFreeze({
  ...DYNAMICS_BUILD_PREPARATION_POLICY,
  staticClosure: DYNAMICS_STATIC_CLOSURE_POLICY
});

export const buildReceiptConfigDigest = sha256(canonicalJson({
  buildContract: DYNAMICS_BUILD_CONTRACT,
  preparationPolicy: closurePreparationPolicy
}));

const assertString = (value: unknown, label: string): string => {
  if (typeof value !== "string") fail(`${label}: expected string`);
  const text = value as string;
  if (text.length === 0) fail(`${label}: expected non-empty string`);
  return text;
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

const assertRecord = (value: unknown, label: string): Readonly<Record<string, unknown>> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label}: expected object`);
  return value as Readonly<Record<string, unknown>>;
};

const asArray = <T>(value: unknown, label: string): readonly T[] => {
  if (!Array.isArray(value)) fail(`${label}: expected array`);
  return value as readonly T[];
};

const assertSha256 = (value: unknown, label: string): string => {
  const text = assertString(value, label);
  if (!SHA256_PATTERN.test(text)) fail(`${label}: expected lowercase sha-256`);
  return text;
};

const assertPortableRelative = (value: unknown, label: string): string => {
  const candidate = assertString(value, label);
  if (!candidate.startsWith("./")) fail(`${label}: expected portable relative path`);
  assertPortablePath(candidate.slice(2), `${label}.portable`);
  return candidate;
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

const sortCanonical = <T>(value: readonly T[]): T[] =>
  [...value].sort((left, right) => compareUtf16(canonicalJson(left), canonicalJson(right)));

const assertModes = (value: unknown, label: string): readonly ("runtime" | "type-only")[] => {
  const raw = asArray<string>(value, label);
  const normalized: ("runtime" | "type-only")[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < raw.length; index += 1) {
    const mode = assertString(raw[index], `${label}[${index}]`);
    if (mode === "runtime") {
      if (seen.has(mode)) fail(`${label}: duplicate mode`);
      seen.add(mode);
      normalized.push("runtime");
    } else if (mode === "type-only") {
      if (seen.has(mode)) fail(`${label}: duplicate mode`);
      seen.add(mode);
      normalized.push("type-only");
    } else {
      fail(`${label}[${index}]: expected runtime/type-only`);
    }
  }
  if (normalized.length === 0) fail(`${label}: expected non-empty mode list`);

  const canonical = [...normalized].sort(compareUtf16);
  if (compareUtf16(canonicalJson(canonical), canonicalJson(normalized)) !== 0) {
    fail(`${label}: non-canonical mode order`);
  }

  return deepFreeze(normalized);
};

const normalizeTypeOnlyFiles = (value: unknown, label: string): readonly { readonly path: string; readonly sha256: string }[] => {
  const raw = asArray<unknown>(value, label);
  if (raw.length === 0) fail(`${label}: expected non-empty files`);

  const files = raw.map((entry, index) => {
    const record = assertRecord(entry, `${label}[${index}]`);
    assertExactKeys(record, `${label}[${index}]`, ["path", "sha256"]);
    return {
      path: assertPortableRelative(record.path, `${label}[${index}].path`),
      sha256: assertSha256(record.sha256, `${label}[${index}].sha256`)
    };
  });

  const seenPaths = new Set<string>();
  for (const file of files) {
    if (seenPaths.has(file.path)) fail(`${label}: duplicate file path`);
    seenPaths.add(file.path);
  }

  const canonical = [...files].sort((left, right) => compareUtf16(left.path, right.path) || compareUtf16(left.sha256, right.sha256));
  if (compareUtf16(canonicalJson(canonical), canonicalJson(files)) !== 0) {
    fail(`${label}: non-canonical file order`);
  }

  return deepFreeze(files);
};

const normalizePreparedDescriptor = (value: unknown, index: number): DynamicsBuildInputDescriptor => {
  const record = assertRecord(value, `prepared.inputs[${index}]`);
  const kind = assertString(record.kind, `prepared.inputs[${index}].kind`);
  switch (kind) {
    case "project": {
      assertExactKeys(record, `prepared.inputs[${index}]`, ["kind", "modes", "path", "sha256"]);
      return {
        kind: "project",
        modes: assertModes(record.modes, `prepared.inputs[${index}].modes`),
        path: assertPortableRelative(record.path, `prepared.inputs[${index}].path`),
        sha256: assertSha256(record.sha256, `prepared.inputs[${index}].sha256`)
      };
    }
    case "package": {
      assertExactKeys(record, `prepared.inputs[${index}]`, [
        "kind",
        "manifest_sha256",
        "modes",
        "package_name",
        "package_path",
        "package_version",
        "sha256"
      ]);
      return {
        kind: "package",
        manifest_sha256: assertSha256(record.manifest_sha256, `prepared.inputs[${index}].manifest_sha256`),
        modes: assertModes(record.modes, `prepared.inputs[${index}].modes`),
        package_name: assertNpmPackageName(record.package_name, `prepared.inputs[${index}].package_name`),
        package_path: assertPortableRelative(record.package_path, `prepared.inputs[${index}].package_path`),
        package_version: assertNpmPackageVersion(record.package_version, `prepared.inputs[${index}].package_version`),
        sha256: assertSha256(record.sha256, `prepared.inputs[${index}].sha256`)
      };
    }
    case "type-only": {
      assertExactKeys(record, `prepared.inputs[${index}]`, ["kind", "files", "manifest_sha256", "package_name", "package_version", "surface"]);
      if (assertNpmPackageName(record.package_name, `prepared.inputs[${index}].package_name`) !== "simfile") {
        fail(`prepared.inputs[${index}].package_name: invalid type-only package`);
      }
      if (assertString(record.surface, `prepared.inputs[${index}].surface`) !== "dynamics") {
        fail(`prepared.inputs[${index}].surface: expected dynamics`);
      }

      return {
        kind: "type-only",
        files: normalizeTypeOnlyFiles(record.files, `prepared.inputs[${index}].files`),
        manifest_sha256: assertSha256(record.manifest_sha256, `prepared.inputs[${index}].manifest_sha256`),
        package_name: "simfile",
        package_version: assertNpmPackageVersion(record.package_version, `prepared.inputs[${index}].package_version`),
        surface: "dynamics"
      };
    }
    default:
      fail(`prepared.inputs[${index}].kind: unsupported kind`);
  }
  return fail(`prepared.inputs[${index}].kind: unsupported kind`);
};

export const normalizePreparedInputs = (value: unknown): readonly DynamicsBuildInputDescriptor[] => {
  const raw = asArray<unknown>(value, "prepared.inputs");
  const normalized = raw.map((entry, index) => normalizePreparedDescriptor(entry, index));

  const sorted = sortCanonical(normalized);
  if (compareUtf16(canonicalJson(sorted), canonicalJson(normalized)) !== 0) {
    fail("prepared.inputs are not canonical sorted");
  }

  const seen = new Set<string>();
  const projectFiles = new Map<string, string>();
  const packageFiles = new Map<string, string>();
  for (const descriptor of normalized) {
    const key = canonicalJson(descriptor);
    if (seen.has(key)) fail(`prepared.inputs contains duplicate descriptor: ${key}`);
    seen.add(key);

    if (descriptor.kind === "project") {
      const previous = projectFiles.get(descriptor.path);
      if (previous !== undefined) {
        if (previous === descriptor.sha256) fail(`prepared.inputs contains duplicate descriptor: ${key}`);
        fail(`prepared.inputs contains same-path conflicting descriptor: ${descriptor.path}`);
      }
      projectFiles.set(descriptor.path, descriptor.sha256);
      continue;
    }

    if (descriptor.kind === "package") {
      const key = `${descriptor.package_name}\u0000${descriptor.package_version}\u0000${descriptor.package_path}`;
      const previous = packageFiles.get(key);
      if (previous !== undefined) {
        if (previous === descriptor.sha256) {
          fail(`prepared.inputs contains duplicate descriptor: ${canonicalJson(descriptor)}`);
        }
        fail(`prepared.inputs contains same-path conflicting descriptor: ${descriptor.package_path}`);
      }
      packageFiles.set(key, descriptor.sha256);
      continue;
    }

    if (descriptor.kind !== "type-only") {
      fail(`prepared.inputs[${normalized.indexOf(descriptor)}].kind: unsupported kind`);
    }
  }

  return deepFreeze(normalized);
};

const normalizeNodeBuiltins = (value: unknown, label: string): readonly string[] => {
  const raw = asArray<unknown>(value, label);
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < raw.length; index += 1) {
    const builtin = assertString(raw[index], `${label}[${index}]`);
    if (!builtin.startsWith("node:")) fail(`${label}[${index}]: expected node builtin`);
    if (!NODE_BUILTINS.has(builtin)) fail(`${label}[${index}]: unexpected node builtin`);
    if (seen.has(builtin)) fail(`${label}: duplicate builtin`);
    seen.add(builtin);
    normalized.push(builtin);
  }

  const canonical = [...normalized].sort(compareUtf16);
  if (compareUtf16(canonicalJson(canonical), canonicalJson(normalized)) !== 0) {
    fail(`${label}: non-canonical order`);
  }

  return deepFreeze(normalized);
};

const normalizeType = (value: unknown, label: string): "none" | "typescript" => {
  const type = assertString(value, label);
  if (type === "none") return "none";
  if (type === "typescript") return "typescript";
  fail(`${label}: expected typecheck mode`);
  throw new Error("unreachable");
};

const assertType = (value: unknown, label: string): string => {
  return assertString(value, label);
};

export const normalizePreparedBuild = (prepared: PreparedDynamicsBuild): NormalizedPreparedBuild => {
  if (typeof prepared.module !== "string" || prepared.module.length === 0) fail("prepared.module: expected non-empty string");

  const artifactBytes = asArray<number>(prepared.artifactBytes, "prepared.artifactBytes").map((entry, index) => {
    if (!Number.isInteger(entry) || entry < 0 || entry > 255) fail(`prepared.artifactBytes[${index}]: expected byte`);
    return entry;
  });
  const artifactSha256 = sha256(Uint8Array.from(artifactBytes));
  const declaredArtifactSha256 = assertSha256(prepared.artifactSha256, "prepared.artifactSha256");
  if (artifactSha256 !== declaredArtifactSha256) fail("prepared artifact SHA mismatch");

  const inputs = normalizePreparedInputs(prepared.inputs);
  const nodeBuiltins = normalizeNodeBuiltins(prepared.nodeExternals, "prepared.nodeExternals");
  const declaredTypecheckMode = normalizeType(prepared.typecheckMode, "prepared.typecheckMode");

  const descriptor = assertRecord(prepared.closureDescriptor, "prepared.closureDescriptor");
  assertExactKeys(descriptor, "prepared.closureDescriptor", [
    "build_contract",
    "entry",
    "esbuild_version",
    "inputs",
    "preparation_policy",
    "typecheck_mode",
    "typescript_version",
    "used_node_builtins"
  ]);

  if (compareUtf16(canonicalJson(descriptor.build_contract), canonicalJson(DYNAMICS_BUILD_CONTRACT)) !== 0) {
    fail("prepared.closureDescriptor.build_contract is not canonical");
  }
  if (compareUtf16(canonicalJson(descriptor.preparation_policy), canonicalJson(closurePreparationPolicy)) !== 0) {
    fail("prepared.closureDescriptor.preparation_policy is not canonical");
  }

  const entry = assertPortableRelative(descriptor.entry, "prepared.closureDescriptor.entry");
  if (entry !== assertPortableRelative(prepared.module, "prepared.module")) fail("prepared.closureDescriptor.entry mismatch");

  const closureInputs = normalizePreparedInputs(descriptor.inputs);
  if (compareUtf16(canonicalJson(closureInputs), canonicalJson(inputs)) !== 0) {
    fail("prepared.closureDescriptor.inputs mismatch prepared inputs");
  }

  const closureBuiltins = normalizeNodeBuiltins(descriptor.used_node_builtins, "prepared.closureDescriptor.used_node_builtins");
  if (compareUtf16(canonicalJson(closureBuiltins), canonicalJson(nodeBuiltins)) !== 0) {
    fail("prepared.closureDescriptor.used_node_builtins mismatch");
  }

  const preparedTypecheckMode = normalizeType(descriptor.typecheck_mode, "prepared.closureDescriptor.typecheck_mode");
  if (preparedTypecheckMode !== declaredTypecheckMode) {
    fail("prepared.typecheckMode mismatch prepared.closureDescriptor.typecheck_mode");
  }

  return deepFreeze({
    artifactBytes: deepFreeze(artifactBytes),
    artifactSha256: declaredArtifactSha256,
    closureSha256: assertSha256(prepared.closureSha256, "prepared.closureSha256"),
    inputs,
    nodeBuiltins,
    closure: {
      entry,
      esbuildVersion: assertType(descriptor.esbuild_version, "prepared.closureDescriptor.esbuild_version"),
      inputs,
      preparedTypecheckMode,
      typescriptVersion: assertType(descriptor.typescript_version, "prepared.closureDescriptor.typescript_version"),
      usedNodeBuiltins: closureBuiltins
    }
  });
};
