import { createHash } from "node:crypto";

export type DynamicsBuildInputDescriptor =
  | Readonly<{
    kind: "project";
    modes: readonly ("runtime" | "type-only")[];
    path: string;
    sha256: string;
  }>
  | Readonly<{
    kind: "package";
    manifest_sha256: string;
    modes: readonly ("runtime" | "type-only")[];
    package_name: string;
    package_path: string;
    package_version: string;
    sha256: string;
  }>
  | Readonly<{
    files: readonly Readonly<{ path: string; sha256: string }> [];
    kind: "type-only";
    manifest_sha256: string;
    package_name: "simfile";
    package_version: string;
    surface: "dynamics";
  }>;

export interface DynamicsClosureIdentityInput {
  readonly buildContract: unknown;
  readonly entry: string;
  readonly esbuildVersion: string;
  readonly inputs: readonly DynamicsBuildInputDescriptor[];
  readonly preparationPolicy: unknown;
  readonly typecheckMode: "none" | "typescript";
  readonly typescriptVersion: string;
  readonly usedNodeBuiltins: readonly string[];
}

export interface DynamicsClosureIdentity {
  readonly descriptor: Readonly<Record<string, unknown>>;
  readonly header: string;
  readonly sha256: string;
}

export const compareUtf16 = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("build identity cannot contain a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(compareUtf16).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("build identity must be JSON data");
};

export const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

export const deepFreeze = <Value>(value: Value): Readonly<Value> => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as Readonly<Value>;
};

/** Creates the portable, unversioned closure identity used in artifact headers. */
export const createDynamicsClosureIdentity = (
  input: DynamicsClosureIdentityInput
): DynamicsClosureIdentity => {
  const descriptor = deepFreeze({
    build_contract: input.buildContract,
    entry: input.entry,
    esbuild_version: input.esbuildVersion,
    inputs: [...input.inputs],
    preparation_policy: input.preparationPolicy,
    typecheck_mode: input.typecheckMode,
    typescript_version: input.typescriptVersion,
    used_node_builtins: [...input.usedNodeBuiltins].sort(compareUtf16)
  });
  const closureSha256 = sha256(canonicalJson(descriptor));
  return deepFreeze({
    descriptor,
    header: `/* simfile-dynamics-closure-sha256:${closureSha256} */\n`,
    sha256: closureSha256
  });
};
