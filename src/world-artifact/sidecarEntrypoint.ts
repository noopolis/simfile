import { createServer, type Server } from "node:http";
import { types } from "node:util";

import { canonicalJson } from "../dynamics/buildIdentity.js";
import {
  activateWorldDecisionClaim,
  enableWorldDecisionClaim,
  WORLD_DECISION_CLAIM_CAPABILITY,
} from "../world/decisionClaim.js";
import { createWorldRuntime } from "../world/runtime.js";
import {
  createWorldSidecarClockObservation,
  WORLD_SIDECAR_CLOCK_PATH,
} from "./clockObservation.js";
import {
  createWorldSidecarReadiness,
  parseWorldSidecarReadiness,
  WORLD_SIDECAR_READINESS_PATH,
} from "./readiness.js";
import {
  parseWorldSidecarCapabilities,
  type WorldSidecarCapability,
} from "./sidecarCapabilities.js";
import {
  type ComposeWorldRuntime,
  type ProveWorldSidecarReadiness,
  type StartWorldSidecarController,
  type StartedWorldSidecar,
  type WorldSidecarActivation,
  type WorldSidecarController,
  parseWorldSidecarConfiguration,
} from "./sidecarConfiguration.js";
import {
  closeWorldSidecarRoot,
  commitWorldSidecarEvidence,
  openWorldSidecarRoot,
  readWorldSidecarSecret,
  removeWorldSidecarEvidence,
  watchWorldSidecarActivation,
  type WorldSidecarActivationWatcher,
} from "./sidecarFilesystem.js";
import {
  captureWorldCheckpoint,
  listenWorldSidecar,
  probeWorldSidecarListener,
  proveDisposableWorldKernel,
  worldReadinessHashes,
  worldReadinessIdentity,
  type WorldReadinessHashes,
} from "./sidecarReadiness.js";
import {
  constructWorldServiceAdapters,
  invalidWorldServiceConfiguration,
  snapshotWorldRuntimeInput,
  type ConstructedWorldServiceEntrypoint,
} from "./worldServiceConstruction.js";

export const startWorldServiceSidecar = async (
  configuration: unknown,
  compose: ComposeWorldRuntime,
  startController?: StartWorldSidecarController,
  proveReadiness?: ProveWorldSidecarReadiness,
  advertisedCapabilities?: unknown,
): Promise<StartedWorldSidecar> => {
  const config = parseWorldSidecarConfiguration(configuration);
  const capabilities = parseWorldSidecarCapabilities(advertisedCapabilities);
  if (typeof compose !== "function" || types.isProxy(compose)
    || startController !== undefined
      && (typeof startController !== "function" || types.isProxy(startController))
    || proveReadiness !== undefined
      && (typeof proveReadiness !== "function" || types.isProxy(proveReadiness))) {
    return invalidWorldServiceConfiguration();
  }
  const secretAuthority = await openWorldSidecarRoot(config.secret_root, false);
  let evidenceAuthority: Awaited<ReturnType<typeof openWorldSidecarRoot>> | undefined;
  let server: Server | undefined;
  let entrypoint: ConstructedWorldServiceEntrypoint | undefined;
  let controller: WorldSidecarController | undefined;
  let activationWatcher: WorldSidecarActivationWatcher | undefined;
  let evidenceBytes: Uint8Array | undefined;
  let evidenceCreated = false;
  let activated = false;
  let activate = (): void => {};
  const activation: WorldSidecarActivation = Object.freeze({
    ready: new Promise<void>((resolve) => { activate = resolve; }),
  });
  try {
    let expectedInitialState: WorldReadinessHashes | undefined;
    if (proveReadiness !== undefined) {
      expectedInitialState = await proveDisposableWorldKernel(await compose(), proveReadiness);
    }
    const liveRuntime = createWorldRuntime(snapshotWorldRuntimeInput(await compose()));
    if (capabilities.includes(WORLD_DECISION_CLAIM_CAPABILITY)) {
      enableWorldDecisionClaim(liveRuntime);
    }
    const liveInitialCheckpoint = captureWorldCheckpoint(liveRuntime);
    const liveInitialState = worldReadinessHashes(liveInitialCheckpoint);
    if (expectedInitialState !== undefined
      && (liveInitialState.mechanics !== expectedInitialState.mechanics
        || liveInitialState.normalized_checkpoint
          !== expectedInitialState.normalized_checkpoint)) {
      throw new Error("world sidecar readiness changed live initial state");
    }
    if (liveInitialCheckpoint.dynamics.next_tick !== 0
      || liveInitialCheckpoint.decisions.phase !== "open"
      || liveInitialCheckpoint.decisions.decisions.length !== 0) {
      throw new Error("world sidecar live readiness is not paused and pristine");
    }
    const liveIdentity = worldReadinessIdentity(liveInitialCheckpoint);
    const readiness = createWorldSidecarReadiness({
      version: "simfile.world-sidecar-readiness.v1",
      status: "ready",
      runtime_abi: config.runtime_abi,
      run_id: liveIdentity.run_id,
      world_instance_id: liveIdentity.world_instance_id,
      artifact_digest: config.activation_bundle_digest ?? null,
      bundle_digest: config.bundle_digest,
      capability_manifest_digests: liveIdentity.capability_manifest_digests,
      ...(capabilities.length === 0 ? {} : {
        capabilities: capabilities.map((identity) => ({
          identity,
          manifest_digest: liveIdentity.capability_manifest_digests[0]!,
        })),
      }),
      mechanics_sha256: liveInitialState.mechanics,
      normalized_checkpoint_sha256: liveInitialState.normalized_checkpoint,
      clock: { state: "paused", next_tick: 0 },
      decisions: { phase: "open", count: 0 },
    });
    const values = await Promise.all(config.bearer_declarations.map(async (declaration) => ({
      declaration,
      bearer: await readWorldSidecarSecret(
        secretAuthority,
        declaration.scope,
        declaration.name,
      ),
    })));
    if (new Set(values.map((item) => item.bearer)).size !== values.length) {
      return invalidWorldServiceConfiguration();
    }
    const resolveBearer = (bearer: string) =>
      values.find((item) => item.bearer === bearer)?.declaration.principal;
    entrypoint = constructWorldServiceAdapters(liveRuntime, resolveBearer, capabilities);
    server = createSidecarServer(
      entrypoint,
      readiness,
      () => activated,
      liveIdentity.run_id,
      liveIdentity.world_instance_id,
    );
    await probeWorldSidecarListener(server, readiness);
    if (startController !== undefined) {
      const candidate = await startController(entrypoint.runtime, activation);
      if (candidate === null || typeof candidate !== "object" || types.isProxy(candidate)
        || typeof candidate.close !== "function") return invalidWorldServiceConfiguration();
      controller = candidate;
    }
    const postControllerCheckpoint = captureWorldCheckpoint(liveRuntime);
    const postControllerState = worldReadinessHashes(postControllerCheckpoint);
    if (postControllerCheckpoint.dynamics.next_tick !== 0
      || postControllerCheckpoint.decisions.decisions.length !== 0
      || postControllerState.mechanics !== liveInitialState.mechanics
      || postControllerState.normalized_checkpoint
        !== liveInitialState.normalized_checkpoint) {
      throw new Error("world sidecar controller changed paused readiness state");
    }
    evidenceAuthority = await openWorldSidecarRoot(config.evidence_root, true);
    evidenceBytes = new TextEncoder().encode(`${canonicalJson(readiness)}\n`);
    evidenceCreated = await commitWorldSidecarEvidence(evidenceAuthority, evidenceBytes);
    await listenWorldSidecar(server, config.network.internal_port, "0.0.0.0");
    const endpoint = `http://127.0.0.1:${config.network.internal_port}`;
    const [healthy, publishedReadiness] = await Promise.all([
      fetch(`${endpoint}/readyz`, { signal: AbortSignal.timeout(2_000) }),
      fetch(`${endpoint}${WORLD_SIDECAR_READINESS_PATH}`, {
        signal: AbortSignal.timeout(2_000),
      }),
    ]);
    if (healthy.status !== 200
      || !healthy.headers.get("content-type")?.startsWith("application/json")
      || publishedReadiness.status !== 200
      || canonicalJson(parseWorldSidecarReadiness(await publishedReadiness.json()))
        !== canonicalJson(readiness)) {
      throw new Error("world sidecar healthy readiness self-test failed");
    }
    if (controller !== undefined && config.activation_bundle_digest !== undefined) {
      activationWatcher = watchWorldSidecarActivation(evidenceAuthority, {
        bundle_digest: config.activation_bundle_digest,
        run_id: liveIdentity.run_id,
      });
      void activationWatcher.ready.then(() => {
        activateSidecar(capabilities, liveRuntime);
        activated = true;
        activate();
      }, () => {});
    } else {
      activateSidecar(capabilities, liveRuntime);
      activated = true;
      activate();
    }
  } catch (cause) {
    await activationWatcher?.close().catch(() => {});
    await controller?.close().catch(() => {});
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await entrypoint?.mcpListener.close().catch(() => {});
    if (evidenceCreated && evidenceAuthority !== undefined && evidenceBytes !== undefined) {
      await removeWorldSidecarEvidence(evidenceAuthority, evidenceBytes).catch(() => {});
    }
    await closeWorldSidecarRoot(evidenceAuthority).catch(() => {});
    await closeWorldSidecarRoot(secretAuthority).catch(() => {});
    throw new Error("world sidecar startup failed", { cause });
  }
  return createStartedSidecar({
    activationWatcher,
    controller,
    entrypoint: entrypoint!,
    evidenceAuthority,
    secretAuthority,
    server: server!,
  });
};

const activateSidecar = (
  capabilities: readonly WorldSidecarCapability[],
  runtime: ConstructedWorldServiceEntrypoint["runtime"],
): void => {
  if (capabilities.includes(WORLD_DECISION_CLAIM_CAPABILITY)) {
    activateWorldDecisionClaim(runtime);
  }
};

const createSidecarServer = (
  entrypoint: ConstructedWorldServiceEntrypoint,
  readiness: ReturnType<typeof createWorldSidecarReadiness>,
  activated: () => boolean,
  runId: string,
  worldInstanceId: string,
): Server => createServer((request, response) => {
  const pathname = request.url?.split("?", 1)[0];
  if (pathname === WORLD_SIDECAR_READINESS_PATH && request.method === "GET") {
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    });
    response.end(canonicalJson(readiness));
  } else if (pathname === WORLD_SIDECAR_CLOCK_PATH && request.method === "GET") {
    if (!activated()) {
      response.writeHead(409, { "cache-control": "no-store" });
      response.end();
      return;
    }
    try {
      const checkpoint = captureWorldCheckpoint(entrypoint.runtime);
      const observation = createWorldSidecarClockObservation({
        action_count: checkpoint.dynamics.next_action_sequence - 1,
        clock: {
          completed_tick: checkpoint.dynamics.next_tick,
          next_tick: checkpoint.dynamics.next_tick + 1,
          state: "running",
        },
        run_id: runId,
        world_instance_id: worldInstanceId,
      });
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      });
      response.end(canonicalJson(observation));
    } catch {
      response.writeHead(503, { "cache-control": "no-store" });
      response.end();
    }
  } else if (pathname === "/mcp") entrypoint.mcpListener(request, response);
  else entrypoint.jsonListener(request, response);
});

const createStartedSidecar = (input: {
  activationWatcher?: WorldSidecarActivationWatcher;
  controller?: WorldSidecarController;
  entrypoint: ConstructedWorldServiceEntrypoint;
  evidenceAuthority: Awaited<ReturnType<typeof openWorldSidecarRoot>> | undefined;
  secretAuthority: Awaited<ReturnType<typeof openWorldSidecarRoot>>;
  server: Server;
}): StartedWorldSidecar => {
  let state: "running" | "closing" | "closed" | "failed" = "running";
  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closed) return closed;
    state = "closing";
    closed = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("world sidecar shutdown failed")), 5_000);
      });
      try {
        const serverClose = new Promise<void>((resolve, reject) => input.server.close(
          (error) => error ? reject(new Error("world sidecar shutdown failed")) : resolve(),
        ));
        input.server.closeAllConnections();
        await Promise.race([Promise.all([
          input.activationWatcher?.close(), input.controller?.close(), serverClose,
          input.entrypoint.mcpListener.close(),
          closeWorldSidecarRoot(input.evidenceAuthority),
          closeWorldSidecarRoot(input.secretAuthority),
        ]), timeout]);
        state = "closed";
      } catch {
        state = "failed";
        throw new Error("world sidecar shutdown failed");
      } finally { if (timer) clearTimeout(timer); }
    })();
    return closed;
  };
  return Object.freeze({
    server: input.server,
    close,
    get state(): string { return state; },
  });
};
