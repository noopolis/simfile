import { parseSimfileIdentifier } from "../schema/identifier.js";
import type { SimfileWorld } from "../schema/model.js";
import type { WorldSurfaceRegistry } from "../world-surface/index.js";
import {
  compileCapabilityManifests,
  type CapabilityManifest,
  type CapabilityManifestArtifact
} from "./capabilityManifest.js";
import {
  bindWorldGrants,
  resolveWorldGrants,
  type BoundWorldGrant,
  type WorldGrantPrincipalResolver
} from "./grants.js";

export interface WorldGrantCompositionInput {
  readonly runId: string;
  readonly principalResolver?: WorldGrantPrincipalResolver;
  readonly surfaceRegistry: WorldSurfaceRegistry;
  readonly world: SimfileWorld;
  readonly worldInstanceId: string;
}

export interface WorldGrantComposition {
  readonly artifacts: readonly CapabilityManifestArtifact[];
  readonly boundGrants: readonly BoundWorldGrant[];
  readonly manifestsByParticipant: Readonly<Record<string, CapabilityManifest>>;
}

/**
 * Derives a deterministic local participant binding label. This label is
 * neither an organization principal nor an agent identity.
 */
export const localWorldGrantPrincipal = (participant: string): string =>
  `participant:${parseSimfileIdentifier(participant)}`;

export const createLocalWorldGrantPrincipalResolver = (
  participants: readonly string[]
): WorldGrantPrincipalResolver => {
  const principalByParticipant = new Map<string, string>();
  const participantByPrincipal = new Map<string, string>();
  for (const rawParticipant of participants) {
    const participant = parseSimfileIdentifier(rawParticipant);
    const principal = localWorldGrantPrincipal(participant);
    if (
      principalByParticipant.has(participant)
      || participantByPrincipal.has(principal)
    ) {
      throw new TypeError(`duplicate local world grant participant ${participant}`);
    }
    principalByParticipant.set(participant, principal);
    participantByPrincipal.set(principal, participant);
  }
  return Object.freeze({
    resolvePrincipal: (participant: string) =>
      principalByParticipant.get(participant),
    resolveParticipant: (principal: string) =>
      participantByPrincipal.get(principal)
  });
};

export const assertWorldGrantManifestCount = (
  grants: readonly BoundWorldGrant[],
  artifacts: readonly CapabilityManifestArtifact[]
): void => {
  if (artifacts.length !== grants.length) {
    throw new Error(
      "world grant manifest compilation was incomplete: "
      + `expected ${grants.length}, received ${artifacts.length}`
    );
  }
};

export const composeWorldGrants = (
  input: WorldGrantCompositionInput
): WorldGrantComposition => {
  const resolved = resolveWorldGrants(input.world, input.surfaceRegistry);
  const boundGrants = bindWorldGrants(
    resolved,
    input.principalResolver ?? createLocalWorldGrantPrincipalResolver(
      resolved.map((grant) => grant.participant)
    )
  );
  const artifacts = compileCapabilityManifests({
    grants: boundGrants,
    runId: input.runId,
    surfaceRegistry: input.surfaceRegistry,
    world: { id: input.world.id },
    worldInstanceId: input.worldInstanceId
  });
  assertWorldGrantManifestCount(boundGrants, artifacts);

  const artifactByPrincipal = new Map(
    artifacts.map((artifact) => [
      artifact.manifest.holder.principal,
      artifact
    ])
  );
  const manifests = Object.create(null) as Record<string, CapabilityManifest>;
  for (const grant of boundGrants) {
    const artifact = artifactByPrincipal.get(grant.principal);
    if (artifact === undefined) {
      throw new Error(
        `world grant manifest is missing for participant ${grant.participant}`
      );
    }
    Object.defineProperty(manifests, grant.participant, {
      enumerable: true,
      value: artifact.manifest
    });
  }
  if (Object.keys(manifests).length !== boundGrants.length) {
    throw new Error("world grant participant manifest lookup is incomplete");
  }
  return Object.freeze({
    artifacts,
    boundGrants,
    manifestsByParticipant: Object.freeze(manifests)
  });
};
