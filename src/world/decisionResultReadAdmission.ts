import { types } from "node:util";
import { parseCapabilityManifest, serializeCapabilityManifest, type CapabilityManifest } from "./capabilityManifest.js";
import type { DecisionRegistry } from "./decisionRegistry.js";

export interface DecisionResultReadVerification {
  readonly decisionId: string;
  readonly principal: string;
  readonly runId: string;
  readonly worldInstanceId: string;
  readonly issuedTick: number;
  readonly validThroughTick: number;
  readonly status: "consumed";
  readonly atTick: number;
}
export interface DecisionResultReadRuntimeIdentity {
  readonly run_id: string;
  readonly world_id: string;
  readonly world_instance_id: string;
  readonly manifest_digest: string;
  readonly state_version: number;
}
export interface DecisionResultReadRequest {
  readonly principal: string;
  readonly runId: string;
  readonly worldInstanceId: string;
  readonly token: string;
  readonly atTick: number;
  readonly manifest: CapabilityManifest;
  readonly runtimeAuthority: DecisionResultReadRuntimeIdentity;
}
export interface DecisionResultReadAdmission {
  readonly __opaque?: never;
}
export interface DecisionResultReadMetadata {
  readonly decisionId: string;
  readonly principal: string;
  readonly runId: string;
  readonly worldInstanceId: string;
  readonly atTick: number;
  readonly issuedTick: number;
  readonly validThroughTick: number;
  readonly manifestDigest: string;
}

export interface DecisionResultReadIssuer {
  admit(input: unknown): DecisionResultReadAdmission;
  read(input: unknown): DecisionResultReadMetadata;
}

type IssuerInput = {
  readonly registry: DecisionRegistry;
  readonly manifest: CapabilityManifest;
  readonly canonicalManifest: CapabilityManifest;
  readonly canonicalManifestBytes: readonly number[];
  readonly holderPrincipal: string;
  readonly runtimeAuthority: DecisionResultReadRuntimeIdentity;
  readonly identitySnapshot: DecisionResultReadRuntimeIdentity;
};
type AdmissionState = DecisionResultReadMetadata & {
  readonly marker: object;
};

const admissions = new WeakMap<object, AdmissionState>();
const verifiers = new WeakMap<object, (input: unknown) => DecisionResultReadVerification>();
export const registerConsumedDecisionResultVerifier = (
  registry: object,
  verifier: (input: unknown) => DecisionResultReadVerification,
): void => {
  if (verifiers.has(registry) || typeof verifier !== "function") throw new TypeError("Consumed verifier registration rejected.");
  verifiers.set(registry, verifier);
};
const binding = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 && value === value.trim();
const ownData = (value: unknown, fields: readonly string[]): Record<string, unknown> | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || types.isProxy(value as object) ||
    Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) return undefined;
  const output: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return undefined;
    output[key as string] = descriptor.value;
  }
  return output;
};
const parseIdentity = (value: unknown): DecisionResultReadRuntimeIdentity | undefined => {
  const source = ownData(value, ["run_id", "world_id", "world_instance_id", "manifest_digest", "state_version"]);
  if (source === undefined || !binding(source.run_id) || !binding(source.world_id) || !binding(source.world_instance_id) ||
    !/^sha256:[a-f0-9]{64}$/u.test(source.manifest_digest as string) || typeof source.state_version !== "number" ||
    !Number.isSafeInteger(source.state_version) || source.state_version < 0) return undefined;
  return source as unknown as DecisionResultReadRuntimeIdentity;
};
const canonicalManifest = (value: unknown): CapabilityManifest | undefined => {
  try {
    const bytes = serializeCapabilityManifest(value as CapabilityManifest);
    return parseCapabilityManifest(bytes);
  } catch { return undefined; }
};
const equalBytes = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);
const sameIdentity = (left: unknown, right: DecisionResultReadRuntimeIdentity): boolean => {
  const parsed = parseIdentity(left);
  return parsed !== undefined &&
  parsed.run_id === right.run_id && parsed.world_id === right.world_id && parsed.world_instance_id === right.world_instance_id &&
  parsed.manifest_digest === right.manifest_digest && parsed.state_version === right.state_version;
};
const parseIssuerInput = (input: unknown): IssuerInput | undefined => {
  const source = ownData(input, ["registry", "manifest", "runtimeAuthority"]);
  if (source === undefined || source.registry === null || typeof source.registry !== "object" ||
    !parseIdentity(source.runtimeAuthority)) return undefined;
  const manifest = source.manifest as CapabilityManifest;
  const canonical = canonicalManifest(manifest);
  const identity = source.runtimeAuthority as DecisionResultReadRuntimeIdentity;
  if (canonical === undefined || identity.run_id !== canonical.run_id || identity.world_id !== canonical.world.id ||
    identity.world_instance_id !== canonical.world.instance_id || identity.manifest_digest !== canonical.manifest_digest
  ) return undefined;
  const canonicalManifestBytes = serializeCapabilityManifest(canonical);
  const canonicalManifestValue = parseCapabilityManifest(canonicalManifestBytes);
  const identitySnapshot = Object.freeze({ run_id: canonicalManifestValue.run_id, world_id: canonicalManifestValue.world.id,
    world_instance_id: canonicalManifestValue.world.instance_id, manifest_digest: canonicalManifestValue.manifest_digest,
    state_version: identity.state_version });
  return { registry: source.registry as DecisionRegistry, manifest, canonicalManifest: canonicalManifestValue,
    canonicalManifestBytes: Object.freeze([...canonicalManifestBytes]), holderPrincipal: canonicalManifestValue.holder.principal,
    runtimeAuthority: identity, identitySnapshot };
};
const parseRequest = (input: unknown, expected: IssuerInput): DecisionResultReadRequest | undefined => {
  const source = ownData(input, ["principal", "runId", "worldInstanceId", "token", "atTick", "manifest", "runtimeAuthority"]);
  if (source === undefined || !binding(source.principal) || !binding(source.runId) || !binding(source.worldInstanceId) ||
    typeof source.token !== "string" || !Number.isSafeInteger(source.atTick as number) || (source.atTick as number) < 0 ||
    source.atTick !== expected.identitySnapshot.state_version ||
    source.manifest !== expected.manifest || source.runtimeAuthority !== expected.runtimeAuthority) return undefined;
  try {
    if (!equalBytes(serializeCapabilityManifest(source.manifest as CapabilityManifest), expected.canonicalManifestBytes) ||
      !sameIdentity(source.runtimeAuthority as DecisionResultReadRuntimeIdentity, expected.identitySnapshot)) return undefined;
  } catch { return undefined; }
  return { principal: source.principal as string, runId: source.runId as string, worldInstanceId: source.worldInstanceId as string,
    token: source.token as string, atTick: source.atTick as number, manifest: source.manifest as CapabilityManifest,
    runtimeAuthority: source.runtimeAuthority as DecisionResultReadRuntimeIdentity };
};
const metadata = (verified: DecisionResultReadVerification, manifestDigest: string): DecisionResultReadMetadata =>
  Object.freeze({ decisionId: verified.decisionId, principal: verified.principal, runId: verified.runId,
    worldInstanceId: verified.worldInstanceId, atTick: verified.atTick, issuedTick: verified.issuedTick,
    validThroughTick: verified.validThroughTick, manifestDigest });

export const createDecisionResultReadAdmission = (input: unknown): DecisionResultReadIssuer => {
  const expected = parseIssuerInput(input);
  if (expected === undefined) throw new TypeError("Invalid result-read admission issuer.");
  const verify = verifiers.get(expected.registry as object);
  if (verify === undefined) throw new TypeError("Invalid result-read admission issuer.");
  const marker = Object.freeze({});
  const byBinding = new Map<string, DecisionResultReadAdmission>();
  const admit = (requestInput: unknown): DecisionResultReadAdmission => {
    const request = parseRequest(requestInput, expected);
    if (request === undefined) throw new TypeError("Invalid result-read admission request.");
    const verified = verify({
      principal: request.principal, runId: request.runId, worldInstanceId: request.worldInstanceId,
      token: request.token, atTick: request.atTick,
    });
    if (verified.principal !== expected.holderPrincipal) throw new TypeError("Invalid result-read admission request.");
    const key = `${verified.decisionId}\0${verified.atTick}`;
    const existing = byBinding.get(key);
    if (existing !== undefined) return existing;
    const admission = Object.freeze(Object.create(null)) as DecisionResultReadAdmission;
    admissions.set(admission as object, Object.freeze({
      ...metadata(verified, expected.canonicalManifest.manifest_digest), marker,
    }));
    byBinding.set(key, admission);
    return admission;
  };
  const read = (input: unknown): DecisionResultReadMetadata => {
    if (input === null || typeof input !== "object") throw new TypeError("Invalid result-read admission.");
    const state = admissions.get(input as object);
    if (state === undefined || state.marker !== marker) throw new TypeError("Invalid result-read admission.");
    const { marker: _marker, ...result } = state;
    return Object.freeze(result);
  };
  return Object.freeze({ admit, read });
};
