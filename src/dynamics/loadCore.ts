import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseClockSpec } from "../runtime/clock.js";
import type { Simfile } from "../schema/model.js";
import { prepareDynamicsBuild } from "./build.js";
import { createDynamicsBuildReceipt } from "./buildReceipt.js";
import {
  persistDynamicsBuild,
  type DynamicsBuildArtifactLifecycle
} from "./buildLoad.js";
import {
  canonicalDynamicsJson,
  cloneDynamicsJsonObject
} from "./canonicalJson.js";
import type {
  DynamicsRunActionSourceInitialization
} from "./runActionSource.js";
import { createDynamicsSession, type DynamicsSession } from "./session.js";
import {
  DYNAMICS_PROVIDER_API_VERSION,
  type DynamicsJsonValue,
  type DynamicsProvider,
  type DynamicsProviderModule,
  type DynamicsProvenance
} from "./types.js";
import {
  assertDynamicsProvider,
  parseDynamicsSeed,
  providerDependencies
} from "./validation.js";

export interface LoadDynamicsArtifactLifecycleOptions {
  readonly evidenceRoot?: string;
  readonly scratchRoot: string;
}

export interface LoadDynamicsSessionOptions {
  artifactLifecycle?: LoadDynamicsArtifactLifecycleOptions;
  seed?: string;
  simfilePath: string;
}

export interface LoadDynamicsCoreResult<Extension = undefined> {
  readonly extension: Extension;
  readonly session: DynamicsSession;
}

type LoadedExtension<Extension> = (
  loaded: Record<string, unknown>,
  initialization: DynamicsRunActionSourceInitialization
) => Extension;

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" && value !== null
  && typeof (value as { then?: unknown }).then === "function";

const freezeJson = <Value extends DynamicsJsonValue>(value: Value): Value => {
  if (Array.isArray(value)) {
    for (const entry of value) freezeJson(entry);
  } else if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) freezeJson(entry);
  }
  return Object.freeze(value);
};

const createProvider = (loaded: Record<string, unknown>): DynamicsProvider => {
  const factory = loaded.createDynamicsProvider;
  if (typeof factory !== "function") {
    throw new Error("dynamics module must export named createDynamicsProvider()");
  }
  const provider = (factory as DynamicsProviderModule["createDynamicsProvider"])();
  if (isPromiseLike(provider)) {
    throw new Error("createDynamicsProvider() must be synchronous");
  }
  assertDynamicsProvider(provider);
  return provider;
};

const createOwnedScratchRoot = async (): Promise<string> =>
  mkdtemp(path.join(await realpath(os.tmpdir()), "simfile-dynamics-load-"));

const throwOutcome = (
  failure: unknown,
  cleanupFailures: readonly unknown[]
): never => {
  if (cleanupFailures.length === 0) throw failure;
  throw new AggregateError(
    [failure, ...cleanupFailures],
    "dynamics loading and artifact cleanup both failed"
  );
};

export const loadDynamicsCore = async <Extension = undefined>(
  simfile: Simfile,
  options: LoadDynamicsSessionOptions,
  loadExtension?: LoadedExtension<Extension>
): Promise<LoadDynamicsCoreResult<Extension> | undefined> => {
  if (!simfile.dynamics) return undefined;

  const seed = parseDynamicsSeed(
    options.seed === undefined ? simfile.clock.seed : options.seed
  );
  const clock = parseClockSpec(simfile.clock);
  const config = cloneDynamicsJsonObject(
    simfile.dynamics.config,
    "dynamics config"
  );
  const configSha256 = sha256(canonicalDynamicsJson(config));
  const requestedSimfilePath = path.resolve(options.simfilePath);
  let ownedScratchRoot: string | undefined;
  let lifecycle: DynamicsBuildArtifactLifecycle | undefined;
  let result: LoadDynamicsCoreResult<Extension> | undefined;
  let failed = false;
  let failure: unknown;
  try {
    const prepared = await prepareDynamicsBuild(
      requestedSimfilePath,
      simfile.dynamics.module
    );
    const absoluteSimfilePath = await realpath(requestedSimfilePath);
    const buildReceipt = await createDynamicsBuildReceipt(
      absoluteSimfilePath,
      prepared
    );
    const scratchRoot = options.artifactLifecycle?.scratchRoot
      ?? (ownedScratchRoot = await createOwnedScratchRoot());
    lifecycle = await persistDynamicsBuild({
      absoluteSimfilePath,
      evidenceRoot: options.artifactLifecycle?.evidenceRoot,
      prepared,
      receipt: buildReceipt,
      scratchRoot
    });
    const loaded = await lifecycle.importArtifact();
    await lifecycle.verify();
    const provider = createProvider(loaded);
    const provenance: DynamicsProvenance = {
      api_version: DYNAMICS_PROVIDER_API_VERSION,
      config_sha256: configSha256,
      module: prepared.module,
      module_sha256: prepared.artifactSha256,
      node_version: process.version,
      numeric_model: "ieee754-binary64",
      provider_dependencies: providerDependencies(provider),
      provider_id: provider.id,
      provider_version: provider.version,
      state_schema_version: provider.state_schema_version
    };
    const session = createDynamicsSession(provider, {
      buildReceipt,
      config,
      provenance,
      seed,
      simSecondsPerTick: clock.simPerTickSeconds
    });
    const initialization = Object.freeze({
      config: freezeJson(cloneDynamicsJsonObject(config, "dynamics config")),
      seed,
      sim_seconds_per_tick: clock.simPerTickSeconds
    });
    result = {
      extension: loadExtension?.(loaded, initialization) as Extension,
      session
    };
  } catch (error) {
    failed = true;
    failure = error;
  }

  const cleanupFailures: unknown[] = [];
  if (lifecycle) {
    try {
      await lifecycle.cleanup();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (ownedScratchRoot) {
    try {
      await rm(ownedScratchRoot, { force: true, recursive: true });
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (failed) throwOutcome(failure, cleanupFailures);
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      cleanupFailures,
      "dynamics artifact cleanup failed"
    );
  }
  if (!result) throw new Error("dynamics loading completed without a session");
  return result;
};
