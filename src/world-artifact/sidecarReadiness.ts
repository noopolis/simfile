import { createHash } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { canonicalJson, compareUtf16 } from "../dynamics/buildIdentity.js";
import type { WorldCheckpoint } from "../world/checkpoint.js";
import { readWorldRuntimeCheckpointCoordinator } from "../world/checkpointRuntime.js";
import { readWorldRuntimeClockAuthority } from "../world/clockAuthority.js";
import { createWorldRuntime, type CreateWorldRuntimeInput, type WorldRuntime } from "../world/runtime.js";
import { WORLD_SIDECAR_CLOCK_PATH } from "./clockObservation.js";
import type { ProveWorldSidecarReadiness } from "./sidecarConfiguration.js";
import {
  parseWorldSidecarReadiness,
  WORLD_SIDECAR_READINESS_PATH,
  type WorldSidecarReadiness,
} from "./readiness.js";
import { snapshotWorldRuntimeInput } from "./worldServiceConstruction.js";

const digestCanonical = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
const normalizedCheckpoint = (checkpoint: WorldCheckpoint): unknown => ({
  ...checkpoint,
  decisions: {
    ...checkpoint.decisions,
    tokenDigestKeyFingerprint: `sha256:${"0".repeat(64)}`,
  },
  action_result_ledger: {
    ...checkpoint.action_result_ledger,
    issuer: "0".repeat(32),
    secret: "0".repeat(64),
  },
});

export interface WorldReadinessHashes {
  readonly mechanics: string;
  readonly normalized_checkpoint: string;
}
export interface WorldReadinessIdentity {
  readonly run_id: string;
  readonly world_instance_id: string;
  readonly capability_manifest_digests: readonly string[];
}

export const worldReadinessHashes = (
  checkpoint: WorldCheckpoint,
): WorldReadinessHashes => Object.freeze({
  mechanics: digestCanonical(checkpoint.dynamics),
  normalized_checkpoint: digestCanonical(normalizedCheckpoint(checkpoint)),
});

export const captureWorldCheckpoint = (runtime: WorldRuntime): WorldCheckpoint => {
  const coordinator = readWorldRuntimeCheckpointCoordinator(runtime);
  if (coordinator === undefined) {
    throw new Error("world sidecar readiness checkpoint unavailable");
  }
  return coordinator.capture();
};

export const worldReadinessIdentity = (
  checkpoint: WorldCheckpoint,
): WorldReadinessIdentity => {
  const first = checkpoint.static.capability_manifests[0]?.manifest;
  if (first === undefined) throw new Error("world sidecar readiness capability unavailable");
  if (checkpoint.static.capability_manifests.some(({ manifest }) =>
    manifest.run_id !== first.run_id
      || manifest.world.instance_id !== first.world.instance_id)) {
    throw new Error("world sidecar readiness capability identity drift");
  }
  const digests = checkpoint.static.capability_manifests
    .map(({ digest }) => digest).sort(compareUtf16);
  return Object.freeze({
    run_id: first.run_id,
    world_instance_id: first.world.instance_id,
    capability_manifest_digests: Object.freeze(digests),
  });
};

export const proveDisposableWorldKernel = async (
  runtimeInput: CreateWorldRuntimeInput,
  proveReadiness: ProveWorldSidecarReadiness,
): Promise<WorldReadinessHashes> => {
  const runtime = createWorldRuntime(snapshotWorldRuntimeInput(runtimeInput));
  const initial = captureWorldCheckpoint(runtime);
  if (initial.static.capability_manifests.length < 1
    || initial.dynamics.next_tick !== 0 || initial.decisions.phase !== "open"
    || initial.decisions.decisions.length !== 0
    || initial.decisions.nextDecisionSequence !== 1) {
    throw new Error("world sidecar readiness registry is not pristine");
  }
  const hashes = worldReadinessHashes(initial);
  await proveReadiness(runtime);
  const afterProof = worldReadinessHashes(captureWorldCheckpoint(runtime));
  if (afterProof.mechanics !== hashes.mechanics
    || afterProof.normalized_checkpoint !== hashes.normalized_checkpoint) {
    throw new Error("world sidecar readiness proof mutated disposable state");
  }
  const clock = readWorldRuntimeClockAuthority(runtime);
  if (clock === undefined) throw new Error("world sidecar readiness mechanics unavailable");
  const expectedTick = initial.dynamics.next_tick;
  const stepped = clock.stepDynamics();
  const after = captureWorldCheckpoint(runtime);
  if (stepped.tick !== expectedTick || after.dynamics.next_tick !== expectedTick + 1
    || after.decisions.decisions.length !== 0) {
    throw new Error("world sidecar readiness mechanics self-test failed");
  }
  return hashes;
};

export const listenWorldSidecar = async (
  server: Server,
  port: number,
  host: string,
): Promise<void> => new Promise<void>((resolve, reject) => {
  const failed = (error: Error): void => {
    server.off("listening", ready);
    reject(new Error("world sidecar listener failed", { cause: error }));
  };
  const ready = (): void => {
    server.off("error", failed);
    resolve();
  };
  server.once("error", failed);
  server.once("listening", ready);
  server.listen(port, host);
});

const stopListening = async (server: Server): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve()
      : reject(new Error("world sidecar listener close failed", { cause: error })));
  });

export const probeWorldSidecarListener = async (
  server: Server,
  readiness: WorldSidecarReadiness,
): Promise<void> => {
  await listenWorldSidecar(server, 0, "127.0.0.1");
  try {
    const address = server.address() as AddressInfo | null;
    if (address === null || typeof address === "string") {
      throw new Error("world sidecar listener self-test failed");
    }
    const endpoint = `http://127.0.0.1:${address.port}`;
    const [ready, worldReadiness, worldClock, json, mcp] = await Promise.all([
      fetch(`${endpoint}/readyz`, { signal: AbortSignal.timeout(2_000) }),
      fetch(`${endpoint}${WORLD_SIDECAR_READINESS_PATH}`, {
        signal: AbortSignal.timeout(2_000),
      }),
      fetch(`${endpoint}${WORLD_SIDECAR_CLOCK_PATH}`, {
        signal: AbortSignal.timeout(2_000),
      }),
      fetch(`${endpoint}/v1/world/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(2_000),
      }),
      fetch(`${endpoint}/mcp`, { method: "POST", signal: AbortSignal.timeout(2_000) }),
    ]);
    if (ready.status !== 200
      || !ready.headers.get("content-type")?.startsWith("application/json")
      || worldReadiness.status !== 200
      || !worldReadiness.headers.get("content-type")?.startsWith("application/json")
      || worldClock.status !== 409 || json.status !== 401 || mcp.status !== 401) {
      throw new Error("world sidecar listener self-test failed");
    }
    const observed = parseWorldSidecarReadiness(await worldReadiness.json());
    if (canonicalJson(observed) !== canonicalJson(readiness)) {
      throw new Error("world sidecar listener readiness drift");
    }
  } finally {
    await stopListening(server);
  }
};
