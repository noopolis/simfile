import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorldSidecarReadiness,
  parseWorldSidecarReadiness,
  verifyWorldSidecarReadiness,
  WORLD_SIDECAR_READINESS_PATH,
  WORLD_SIDECAR_READINESS_VERSION,
} from "./readiness.js";

const sha = (value: string): string => `sha256:${value.repeat(64).slice(0, 64)}`;
const readiness = () => ({
  version: WORLD_SIDECAR_READINESS_VERSION,
  status: "ready" as const,
  runtime_abi: "simfile.world-sidecar-runtime.v1" as const,
  run_id: "run-one",
  world_instance_id: "run-one-world",
  artifact_digest: sha("a"),
  bundle_digest: sha("b"),
  capability_manifest_digests: [sha("c"), sha("d")],
  mechanics_sha256: sha("e"),
  normalized_checkpoint_sha256: sha("f"),
  clock: { state: "paused" as const, next_tick: 0 as const },
  decisions: { phase: "open" as const, count: 0 as const },
});

test("world-only readiness is versioned, secret-free, paused, and pristine", () => {
  assert.equal(WORLD_SIDECAR_READINESS_PATH, "/v1/world/readiness");
  const parsed = createWorldSidecarReadiness(readiness());
  assert.deepEqual(parsed, readiness());
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(JSON.stringify(parsed).includes("token"), false);
  assert.equal(JSON.stringify(parsed).includes("participant"), false);
});

test("readiness optionally binds capability identities to advertised manifests", () => {
  const base = readiness();
  const advertised = {
    ...base,
    capabilities: [{
      identity: "example.world-operation.v1",
      manifest_digest: base.capability_manifest_digests[0]!,
    }],
  };
  assert.deepEqual(parseWorldSidecarReadiness(base), base, "base v1 remains loadable");
  assert.deepEqual(parseWorldSidecarReadiness(advertised), advertised);
  assert.throws(() => parseWorldSidecarReadiness({
    ...advertised,
    capabilities: [{
      ...advertised.capabilities[0], manifest_digest: sha("f"),
    }],
  }), /capabilit/u);
});

test("world-only readiness rejects forged shape, state, and identities", () => {
  const valid = readiness();
  for (const forged of [
    { ...valid, extra: true },
    { ...valid, version: "simfile.world-sidecar-readiness.latest" },
    { ...valid, runtime_abi: "simfile.world-sidecar-runtime.v2" },
    { ...valid, capability_manifest_digests: [...valid.capability_manifest_digests].reverse() },
    { ...valid, clock: { state: "running", next_tick: 1 } },
    { ...valid, decisions: { phase: "open", count: 1 } },
  ]) {
    assert.throws(() => parseWorldSidecarReadiness(forged));
  }
});

test("world-only readiness verification rejects stale run and artifact correlation", () => {
  const valid = readiness();
  const expectation = {
    run_id: valid.run_id,
    world_instance_id: valid.world_instance_id,
    artifact_digest: valid.artifact_digest,
    bundle_digest: valid.bundle_digest,
    capability_manifest_digests: valid.capability_manifest_digests,
    mechanics_sha256: valid.mechanics_sha256,
    normalized_checkpoint_sha256: valid.normalized_checkpoint_sha256,
  };
  assert.deepEqual(verifyWorldSidecarReadiness(valid, expectation), valid);
  for (const stale of [
    { ...expectation, run_id: "run-other" },
    { ...expectation, artifact_digest: sha("0") },
    { ...expectation, bundle_digest: sha("0") },
    { ...expectation, capability_manifest_digests: [sha("0")] },
    { ...expectation, mechanics_sha256: sha("0") },
    { ...expectation, normalized_checkpoint_sha256: sha("0") },
  ]) {
    assert.throws(
      () => verifyWorldSidecarReadiness(valid, stale),
      /does not match/u,
    );
  }
  const advertised = {
    ...valid,
    capabilities: [{
      identity: "example.world-operation.v1",
      manifest_digest: valid.capability_manifest_digests[0]!,
    }],
  };
  assert.throws(() => verifyWorldSidecarReadiness(advertised, expectation), /does not match/u);
  assert.deepEqual(verifyWorldSidecarReadiness(advertised, {
    ...expectation, capabilities: advertised.capabilities,
  }), advertised);
});
