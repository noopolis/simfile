import { compareUtf16 } from "../dynamics/buildIdentity.js";
import { exactData, frozen, sortedUniqueText } from "./data.js";

export const WORLD_SIDECAR_READINESS_VERSION =
  "simfile.world-sidecar-readiness.v1" as const;
export const WORLD_SIDECAR_READINESS_PATH = "/v1/world/readiness" as const;

const RUNTIME_ABI = "simfile.world-sidecar-runtime.v1" as const;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface WorldSidecarReadiness {
  readonly version: typeof WORLD_SIDECAR_READINESS_VERSION;
  readonly status: "ready";
  readonly runtime_abi: typeof RUNTIME_ABI;
  readonly run_id: string;
  readonly world_instance_id: string;
  readonly artifact_digest: string | null;
  readonly bundle_digest: string;
  readonly capability_manifest_digests: readonly string[];
  readonly capabilities?: readonly WorldSidecarCapabilityIdentity[];
  readonly mechanics_sha256: string;
  readonly normalized_checkpoint_sha256: string;
  readonly clock: Readonly<{ readonly state: "paused"; readonly next_tick: 0 }>;
  readonly decisions: Readonly<{ readonly phase: "open"; readonly count: 0 }>;
}

export interface WorldSidecarCapabilityIdentity {
  readonly identity: string;
  readonly manifest_digest: string;
}

export interface WorldSidecarReadinessExpectation {
  readonly run_id: string;
  readonly world_instance_id: string;
  readonly artifact_digest: string | null;
  readonly bundle_digest: string;
  readonly capability_manifest_digests: readonly string[];
  readonly capabilities?: readonly WorldSidecarCapabilityIdentity[];
  readonly mechanics_sha256: string;
  readonly normalized_checkpoint_sha256: string;
}

const digest = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new TypeError(`world sidecar readiness ${label} is invalid`);
  }
  return value;
};

const identifier = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !ID.test(value)) {
    throw new TypeError(`world sidecar readiness ${label} is invalid`);
  }
  return value;
};

const capabilityDigests = (value: unknown): readonly string[] => {
  const output = sortedUniqueText(value, 4096, 71, "readiness capability digests");
  if (output.length < 1 || output.some((item) => !SHA256.test(item))) {
    throw new TypeError("world sidecar readiness capability digests are invalid");
  }
  return output;
};

const capabilities = (
  value: unknown,
  manifests: readonly string[],
): readonly WorldSidecarCapabilityIdentity[] => {
  if (!Array.isArray(value) || value.length > 32) {
    throw new TypeError("world sidecar readiness capabilities are invalid");
  }
  const parsed = value.map((entry) => {
    const fields = exactData(entry, ["identity", "manifest_digest"], "readiness capability");
    const identityValue = identifier(fields.identity, "capability identity");
    if (!/^[a-z][a-z0-9.-]{0,127}\.v[1-9][0-9]*$/u.test(identityValue)) {
      throw new TypeError("world sidecar readiness capability identity is invalid");
    }
    return frozen({
      identity: identityValue,
      manifest_digest: digest(fields.manifest_digest, "capability manifest digest"),
    });
  });
  if (new Set(parsed.map((entry) => entry.identity)).size !== parsed.length
    || parsed.some((entry, index) => index > 0
      && parsed[index - 1]!.identity >= entry.identity)
    || parsed.some((entry) => !manifests.includes(entry.manifest_digest))) {
    throw new TypeError("world sidecar readiness capabilities are invalid");
  }
  return frozen(parsed);
};

export const parseWorldSidecarReadiness = (value: unknown): WorldSidecarReadiness => {
  const hasCapabilities = value !== null && typeof value === "object"
    && Object.hasOwn(value, "capabilities");
  const root = exactData(value, [
    "version", "status", "runtime_abi", "run_id", "world_instance_id",
    "artifact_digest", "bundle_digest", "capability_manifest_digests",
    ...(hasCapabilities ? ["capabilities"] : []),
    "mechanics_sha256", "normalized_checkpoint_sha256", "clock", "decisions",
  ], "readiness");
  if (root.version !== WORLD_SIDECAR_READINESS_VERSION
    || root.status !== "ready"
    || root.runtime_abi !== RUNTIME_ABI) {
    throw new TypeError("world sidecar readiness identity is invalid");
  }
  const clock = exactData(root.clock, ["state", "next_tick"], "readiness clock");
  const decisions = exactData(root.decisions, ["phase", "count"], "readiness decisions");
  if (clock.state !== "paused" || clock.next_tick !== 0
    || decisions.phase !== "open" || decisions.count !== 0) {
    throw new TypeError("world sidecar readiness is not paused and pristine");
  }
  const artifactDigest = root.artifact_digest === null
    ? null
    : digest(root.artifact_digest, "artifact digest");
  const manifests = capabilityDigests(root.capability_manifest_digests);
  return frozen({
    version: WORLD_SIDECAR_READINESS_VERSION,
    status: "ready" as const,
    runtime_abi: RUNTIME_ABI,
    run_id: identifier(root.run_id, "run id"),
    world_instance_id: identifier(root.world_instance_id, "world instance id"),
    artifact_digest: artifactDigest,
    bundle_digest: digest(root.bundle_digest, "bundle digest"),
    capability_manifest_digests: manifests,
    ...(hasCapabilities ? { capabilities: capabilities(root.capabilities, manifests) } : {}),
    mechanics_sha256: digest(root.mechanics_sha256, "mechanics digest"),
    normalized_checkpoint_sha256: digest(
      root.normalized_checkpoint_sha256,
      "checkpoint digest",
    ),
    clock: { state: "paused" as const, next_tick: 0 as const },
    decisions: { phase: "open" as const, count: 0 as const },
  });
};

export const createWorldSidecarReadiness = (
  value: WorldSidecarReadiness,
): WorldSidecarReadiness => parseWorldSidecarReadiness(value);

export const verifyWorldSidecarReadiness = (
  value: unknown,
  expectation: WorldSidecarReadinessExpectation,
): WorldSidecarReadiness => {
  const parsed = parseWorldSidecarReadiness(value);
  const expectedCapabilities = [...expectation.capability_manifest_digests]
    .sort(compareUtf16);
  const expectedIdentities = expectation.capabilities ?? [];
  const actualIdentities = parsed.capabilities ?? [];
  if (parsed.run_id !== expectation.run_id
    || parsed.world_instance_id !== expectation.world_instance_id
    || parsed.artifact_digest !== expectation.artifact_digest
    || parsed.bundle_digest !== expectation.bundle_digest
    || parsed.mechanics_sha256 !== expectation.mechanics_sha256
    || parsed.normalized_checkpoint_sha256
      !== expectation.normalized_checkpoint_sha256
    || parsed.capability_manifest_digests.length !== expectedCapabilities.length
    || parsed.capability_manifest_digests.some(
      (item, index) => item !== expectedCapabilities[index],
    )
    || JSON.stringify(actualIdentities) !== JSON.stringify(expectedIdentities)) {
    throw new TypeError("world sidecar readiness does not match the expected world");
  }
  return parsed;
};
