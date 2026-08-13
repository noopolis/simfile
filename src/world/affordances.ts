import { compareUtf16 } from "../dynamics/buildIdentity.js";
import { DYNAMICS_LIMITS } from "../dynamics/limits.js";
import { sameDynamicsSessionSnapshot } from "../dynamics/sameDynamicsSessionSnapshot.js";
import type { DynamicsSession } from "../dynamics/session.js";
import type { WorldSurfaceRegistry } from "../world-surface/index.js";
import { parseWorldSurfaceObservation } from "../world-surface/observation.js";
import type { LocalResourceReference } from "./addresses.js";
import { resolveWorldAddress, type CanonicalWorldAddress } from "./addresses.js";
import type { CapabilityManifest } from "./capabilityManifest.js";
import { observeScopedWorldRuntime } from "./observe.js";
import type { WorldRuntimeIdentity } from "./runtime.js";

export interface WorldRuntimeAffordance {
  readonly address: CanonicalWorldAddress;
  readonly targets: readonly CanonicalWorldAddress[];
}

export interface WorldRuntimeAffordances {
  readonly identity: WorldRuntimeIdentity;
  readonly affordances: readonly WorldRuntimeAffordance[];
}

type Dependencies = Readonly<{ dynamics: DynamicsSession; surfaceRegistry: WorldSurfaceRegistry }>;
type LocalAffordance = { readonly address: LocalResourceReference; readonly targets: readonly LocalResourceReference[]; readonly canonicalTargets: readonly CanonicalWorldAddress[] };

const canonical = (worldId: string, local: LocalResourceReference): CanonicalWorldAddress =>
  resolveWorldAddress({ id: worldId as never }, local);
const checkpoint = (dynamics: DynamicsSession): ReturnType<DynamicsSession["snapshot"]> => dynamics.snapshot();
const restore = (dynamics: DynamicsSession, value: ReturnType<DynamicsSession["snapshot"]>): void => { try { dynamics.restore(value); } catch { /* The caller denies. */ } };
const unchanged = (dynamics: DynamicsSession, before: ReturnType<DynamicsSession["snapshot"]>): boolean => {
  try { if (sameDynamicsSessionSnapshot(dynamics.snapshot(), before)) return true; } catch { /* Restore below. */ }
  restore(dynamics, before);
  return false;
};
const fail = (): never => { throw new Error("denied"); };

const localAffordances = (manifest: CapabilityManifest, registry: WorldSurfaceRegistry): readonly LocalAffordance[] => {
  if (manifest.affordances.length > DYNAMICS_LIMITS.sense_grants) return fail();
  const entities = new Map(registry.entities.map((entry) => [canonical(manifest.world.id, entry.address), entry.address]));
  const output: LocalAffordance[] = [];
  for (const granted of manifest.affordances) {
    const entry = registry.affordances.find((candidate) => canonical(manifest.world.id, candidate.address) === granted.address);
    if (entry === undefined) return fail();
    const declared = entry.target_selector;
    if (declared.kind !== granted.target_selector.kind) return fail();
    const canonicalTargets = granted.target_selector.kind === "holder"
      ? [manifest.holder.entity]
      : [...granted.target_selector.targets];
    if (canonicalTargets.length > DYNAMICS_LIMITS.sense_grants
      || canonicalTargets.some((target, index) => index > 0 && compareUtf16(canonicalTargets[index - 1]!, target) >= 0)) return fail();
    const targets = canonicalTargets.map((target) => {
      const local = entities.get(target); if (local === undefined) return fail(); return local;
    });
    const declaredTargets = declared.kind === "holder" ? [manifest.holder.entity]
      : declared.targets.map((target) => canonical(manifest.world.id, target)).sort(compareUtf16);
    if (declaredTargets.length !== canonicalTargets.length
      || declaredTargets.some((target, index) => target !== canonicalTargets[index])) return fail();
    output.push({ address: entry.address, targets: Object.freeze(targets), canonicalTargets: Object.freeze(canonicalTargets) });
  }
  return Object.freeze(output);
};

/** @internal B67 evaluator; public callers use WorldRuntime.affordances. */
export const affordancesWorldRuntime = (dependencies: Dependencies, manifest: CapabilityManifest, identity: WorldRuntimeIdentity): WorldRuntimeAffordances => {
  const afforded = localAffordances(manifest, dependencies.surfaceRegistry);
  if (afforded.length === 0) return Object.freeze({ identity: Object.freeze({ ...identity }), affordances: Object.freeze([]) });
  let outer: ReturnType<DynamicsSession["snapshot"]>;
  try { outer = checkpoint(dependencies.dynamics); } catch { return fail(); }
  try {
    if (dependencies.dynamics.nextTick !== identity.state_version) return fail();
    const projected = manifest.senses.map((sense) => observeScopedWorldRuntime(dependencies, manifest, identity, sense.address).observation.channels);
    const observation = parseWorldSurfaceObservation({ channels: projected.flat() }, "aggregate affordance observation");
    if (dependencies.dynamics.nextTick !== identity.state_version) return fail();
    const holder = dependencies.surfaceRegistry.entities.find((entry) => canonical(manifest.world.id, entry.address) === manifest.holder.entity);
    if (holder === undefined) return fail();
    const results: WorldRuntimeAffordance[] = [];
    let totalTargets = 0;
    for (const affordance of afforded) {
      const targets: CanonicalWorldAddress[] = [];
      for (const [index, target] of affordance.targets.entries()) {
        const before = checkpoint(dependencies.dynamics);
        let available: boolean;
        try { available = dependencies.surfaceRegistry.isAffordanceAvailable(affordance.address, Object.freeze({ holder: holder.address, observation, target })); }
        catch { unchanged(dependencies.dynamics, before); return fail(); }
        if (!unchanged(dependencies.dynamics, before) || dependencies.dynamics.nextTick !== identity.state_version) return fail();
        if (available) targets.push(affordance.canonicalTargets[index]!);
      }
      if (targets.length > 0) {
        totalTargets += targets.length;
        if (totalTargets > DYNAMICS_LIMITS.sense_grants * DYNAMICS_LIMITS.sense_grants) return fail();
        results.push(Object.freeze({ address: canonical(manifest.world.id, affordance.address), targets: Object.freeze(targets.sort(compareUtf16)) }));
      }
    }
    if (!unchanged(dependencies.dynamics, outer) || dependencies.dynamics.nextTick !== identity.state_version) return fail();
    return Object.freeze({ identity: Object.freeze({ ...identity }), affordances: Object.freeze(results.sort((left, right) => compareUtf16(left.address, right.address))) });
  } catch {
    unchanged(dependencies.dynamics, outer);
    return fail();
  }
};
