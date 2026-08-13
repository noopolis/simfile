import type { BoundWorldGrant } from "./grants.js";

const issuedBoundGrantSets = new WeakSet<object>();

const freezeGrant = (grant: BoundWorldGrant): BoundWorldGrant => Object.freeze({
  participant: grant.participant,
  principal: grant.principal,
  entity: grant.entity,
  senses: Object.freeze([...grant.senses]),
  affordances: Object.freeze([...grant.affordances]),
});

/** @internal Exact B18 grant-set authority for world-runtime composition. */
export const issueBoundWorldGrants = (grants: readonly BoundWorldGrant[]): readonly BoundWorldGrant[] => {
  const issued = Object.freeze(grants.map(freezeGrant));
  issuedBoundGrantSets.add(issued);
  return issued;
};

/** @internal Rejects copies, proxies, and every non-issued grant-set value. */
export const readBoundWorldGrants = (value: unknown): readonly BoundWorldGrant[] | undefined =>
  value !== null && typeof value === "object" && issuedBoundGrantSets.has(value) ? value as readonly BoundWorldGrant[] : undefined;
