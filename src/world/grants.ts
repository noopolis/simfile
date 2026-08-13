import type { SimfileWorld } from "../schema/model.js";
import { parseSimfileIdentifier } from "../schema/identifier.js";
import type { WorldSurfaceRegistry } from "../world-surface/index.js";
import {
  parseLocalResourceReference,
  parseWorldId,
  resolveWorldAddress,
  type CanonicalWorldAddress,
  type LocalResourceReference
} from "./addresses.js";
import { issueBoundWorldGrants } from "./grantAttestation.js";

type GrantableResourceKind = "entity" | "sense" | "affordance";

export interface ResolvedWorldGrant {
  readonly participant: string;
  readonly entity: CanonicalWorldAddress;
  readonly senses: readonly CanonicalWorldAddress[];
  readonly affordances: readonly CanonicalWorldAddress[];
}

export interface BoundWorldGrant extends ResolvedWorldGrant {
  readonly principal: string;
}

export interface WorldGrantPrincipalResolver {
  resolvePrincipal(participant: string): string | undefined;
  resolveParticipant(principal: string): string | undefined;
}

const localReferenceOfKind = (
  value: unknown,
  kind: GrantableResourceKind,
  path: string
): LocalResourceReference => {
  let reference: LocalResourceReference;
  try {
    reference = parseLocalResourceReference(value);
  } catch (error) {
    throw new TypeError(`${path} must be a local ${kind}: reference`, { cause: error });
  }
  if (!reference.startsWith(`${kind}:`)) {
    throw new TypeError(`${path} must be a local ${kind}: reference`);
  }
  return reference;
};

const declaredReference = (
  reference: LocalResourceReference,
  declarations: readonly { readonly address: LocalResourceReference }[],
  path: string
): LocalResourceReference => {
  if (!declarations.some((declaration) => declaration.address === reference)) {
    throw new TypeError(`${path} is not declared by the checked world surface`);
  }
  return reference;
};

const uniqueReferences = (
  references: readonly unknown[],
  kind: "sense" | "affordance",
  declarations: readonly { readonly address: LocalResourceReference }[],
  participant: string
): readonly LocalResourceReference[] => {
  const parsed: LocalResourceReference[] = [];
  const seen = new Set<string>();
  for (const [index, value] of references.entries()) {
    const path = `world.grants.${participant}.${kind}s[${index}]`;
    const reference = declaredReference(localReferenceOfKind(value, kind, path), declarations, path);
    if (seen.has(reference)) throw new TypeError(`${path} duplicates a ${kind} grant`);
    seen.add(reference);
    parsed.push(reference);
  }
  return parsed;
};

const resolvedReferences = (
  worldId: ReturnType<typeof parseWorldId>,
  references: readonly LocalResourceReference[]
): readonly CanonicalWorldAddress[] => Object.freeze(
  references.map((reference) => resolveWorldAddress({ id: worldId }, reference))
);

/**
 * Resolves parsed, authored grants against a checked B16 world-surface registry.
 * This is deliberately independent of organization/principal identity binding.
 */
export const resolveWorldGrants = (
  world: SimfileWorld,
  surfaceRegistry: WorldSurfaceRegistry
): readonly ResolvedWorldGrant[] => {
  const worldId = parseWorldId(world.id);
  const grants = world.grants;
  const records: ResolvedWorldGrant[] = [];

  for (const participant of Object.keys(grants).map(parseSimfileIdentifier).sort()) {
    const grant = grants[participant]!;
    const entityPath = `world.grants.${participant}.entity`;
    const entityReference = declaredReference(
      localReferenceOfKind(grant.entity, "entity", entityPath),
      surfaceRegistry.entities,
      entityPath
    );
    const senses = uniqueReferences(
      grant.senses,
      "sense",
      surfaceRegistry.senses,
      participant
    );
    const affordances = uniqueReferences(
      grant.affordances,
      "affordance",
      surfaceRegistry.affordances,
      participant
    );
    records.push(Object.freeze({
      participant,
      entity: resolveWorldAddress({ id: worldId }, entityReference),
      senses: resolvedReferences(worldId, senses),
      affordances: resolvedReferences(worldId, affordances)
    }));
  }

  return Object.freeze(records);
};

/**
 * Binds standalone grant records to an injected, round-trippable organization
 * principal mapping. No organization implementation is imported here.
 */
export const bindWorldGrants = (
  grants: readonly ResolvedWorldGrant[],
  resolver: WorldGrantPrincipalResolver
): readonly BoundWorldGrant[] => {
  if (!resolver || typeof resolver.resolvePrincipal !== "function"
    || typeof resolver.resolveParticipant !== "function") {
    throw new TypeError("World grant binding requires a two-way principal resolver");
  }

  const principals = new Set<string>();
  const bound: BoundWorldGrant[] = [];
  for (const grant of grants) {
    const principal = resolver.resolvePrincipal(grant.participant);
    if (typeof principal !== "string" || principal.length === 0 || principal !== principal.trim()) {
      throw new TypeError(`world grant participant ${grant.participant} has no principal`);
    }
    if (principals.has(principal)) {
      throw new TypeError(`world grant principal ${principal} is bound more than once`);
    }
    if (resolver.resolveParticipant(principal) !== grant.participant) {
      throw new TypeError(`world grant principal ${principal} does not round-trip to ${grant.participant}`);
    }
    principals.add(principal);
    bound.push(Object.freeze({
      participant: grant.participant,
      principal,
      entity: grant.entity,
      senses: Object.freeze([...grant.senses]),
      affordances: Object.freeze([...grant.affordances])
    }));
  }
  return issueBoundWorldGrants(bound);
};

export const bindWorldGrantPrincipals = bindWorldGrants;
