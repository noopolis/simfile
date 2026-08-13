import { types } from "node:util";

import type { DynamicsSession } from "../dynamics/session.js";
import { sameDynamicsSessionSnapshot } from "../dynamics/sameDynamicsSessionSnapshot.js";
import type { WorldSurfaceRegistry } from "../world-surface/index.js";
import type { ReadonlyWorldSurfaceObservation } from "../world-surface/types.js";
import {
  resolveWorldAddress,
  type CanonicalWorldAddress,
  type LocalResourceReference,
} from "./addresses.js";
import type { CapabilityManifest } from "./capabilityManifest.js";
import type { WorldRuntimeIdentity } from "./runtime.js";

export interface WorldObserveRequest {
  readonly sense: CanonicalWorldAddress;
}

export interface WorldRuntimeObservation {
  readonly identity: WorldRuntimeIdentity;
  readonly sense: CanonicalWorldAddress;
  readonly observer: CanonicalWorldAddress;
  readonly observation: {
    readonly channels: readonly {
      readonly components: Readonly<Record<string, number>>;
      readonly frame?: string;
      readonly sense_address: CanonicalWorldAddress;
      readonly subject_address: CanonicalWorldAddress;
      readonly unit?: string;
    }[];
  };
}

type ObserveDependencies = Readonly<{ dynamics: DynamicsSession; surfaceRegistry: WorldSurfaceRegistry }>;
type ScopedWorldObservation = Readonly<{
  holder: LocalResourceReference;
  observation: ReadonlyWorldSurfaceObservation;
}>;

const isProxy = (value: unknown): boolean => value !== null && typeof value === "object" && types.isProxy(value as object);

const requestSense = (value: unknown): CanonicalWorldAddress | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const keys = Reflect.ownKeys(value);
  const descriptor = Object.getOwnPropertyDescriptor(value, "sense");
  if (keys.length !== 1 || keys[0] !== "sense" || !descriptor?.enumerable || !("value" in descriptor)
    || typeof descriptor.value !== "string") return undefined;
  return descriptor.value as CanonicalWorldAddress;
};

const canonical = (worldId: string, local: string): CanonicalWorldAddress =>
  resolveWorldAddress({ id: worldId as never }, local as LocalResourceReference);

const freezeChannel = (
  worldId: string,
  value: { readonly components: Readonly<Record<string, number>>; readonly frame?: string; readonly sense_address: string; readonly subject_address: string; readonly unit?: string },
): WorldRuntimeObservation["observation"]["channels"][number] => {
  const components = Object.freeze(Object.fromEntries(Object.entries(value.components)));
  return Object.freeze({
    components,
    ...(value.frame === undefined ? {} : { frame: value.frame }),
    sense_address: canonical(worldId, value.sense_address),
    subject_address: canonical(worldId, value.subject_address),
    ...(value.unit === undefined ? {} : { unit: value.unit }),
  });
};

const projectionDidNotMutateSession = (
  dynamics: DynamicsSession,
  checkpoint: ReturnType<DynamicsSession["snapshot"]>,
): boolean => {
  try {
    const current = dynamics.snapshot();
    if (sameDynamicsSessionSnapshot(current, checkpoint)) return true;
  } catch {
    // A failed inspection is treated as a possible mutation and recovered below.
  }
  try { dynamics.restore(checkpoint); } catch { /* Denial remains authoritative. */ }
  return false;
};

/** @internal Shared B66/B67 scoped local observation; not part of the public barrel. */
export const observeScopedWorldRuntime = (
  dependencies: ObserveDependencies,
  manifest: CapabilityManifest,
  identity: WorldRuntimeIdentity,
  requested: CanonicalWorldAddress,
): ScopedWorldObservation => {
  if (!manifest.senses.some((sense) => sense.address === requested)) throw new Error("denied");
  const worldId = manifest.world.id;
  const sense = dependencies.surfaceRegistry.senses.find((entry) => canonical(worldId, entry.address) === requested);
  const holder = dependencies.surfaceRegistry.entities.find((entry) => canonical(worldId, entry.address) === manifest.holder.entity);
  if (sense === undefined || holder === undefined) throw new Error("denied");
  if (dependencies.dynamics.nextTick !== identity.state_version) throw new Error("denied");
  let providerCheckpoint: ReturnType<DynamicsSession["snapshot"]> | undefined;
  let mechanics: ReturnType<DynamicsSession["observe"]>;
  try {
    providerCheckpoint = dependencies.dynamics.snapshot();
    mechanics = dependencies.dynamics.observe({ observer: holder.dynamics_address,
      principal_id: manifest.holder.principal, sense_addresses: [...sense.dynamics_senses] });
  } catch {
    if (providerCheckpoint !== undefined) projectionDidNotMutateSession(dependencies.dynamics, providerCheckpoint);
    throw new Error("denied");
  }
  if (!projectionDidNotMutateSession(dependencies.dynamics, providerCheckpoint)
    || mechanics.tick !== identity.state_version || mechanics.observer !== holder.dynamics_address
    || mechanics.principal_id !== manifest.holder.principal || dependencies.dynamics.nextTick !== identity.state_version) throw new Error("denied");
  let checkpoint: ReturnType<DynamicsSession["snapshot"]>;
  try { checkpoint = dependencies.dynamics.snapshot(); } catch { throw new Error("denied"); }
  let projected: ReturnType<WorldSurfaceRegistry["projectSense"]>;
  try {
    projected = dependencies.surfaceRegistry.projectSense(sense.address, {
      holder: holder.address,
      observation: { channels: mechanics.channels },
    });
  } catch {
    projectionDidNotMutateSession(dependencies.dynamics, checkpoint);
    throw new Error("denied");
  }
  if (!projectionDidNotMutateSession(dependencies.dynamics, checkpoint)
    || dependencies.dynamics.nextTick !== identity.state_version) throw new Error("denied");
  return Object.freeze({ holder: holder.address, observation: projected });
};

/** @internal B66 runtime orchestration; public callers use WorldRuntime.observe. */
export const observeWorldRuntime = (
  dependencies: ObserveDependencies,
  manifest: CapabilityManifest,
  identity: WorldRuntimeIdentity,
  value: unknown,
): WorldRuntimeObservation => {
  const requested = requestSense(value);
  if (requested === undefined) throw new Error("denied");
  const local = observeScopedWorldRuntime(dependencies, manifest, identity, requested);
  const channels = Object.freeze(local.observation.channels.map((channel) => freezeChannel(manifest.world.id, channel)));
  return Object.freeze({ identity: Object.freeze({ ...identity }), sense: requested,
    observer: manifest.holder.entity, observation: Object.freeze({ channels }) });
};
