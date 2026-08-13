import { randomBytes } from "node:crypto";

import type { DynamicsSession } from "../dynamics/session.js";
import type { SimfileWorld } from "../schema/model.js";
import type { WorldSurfaceRegistry } from "../world-surface/index.js";
import { composeWorldGrants } from "./grantComposition.js";
import type { WorldGrantPrincipalResolver } from "./grants.js";
import { createDecisionRegistry } from "./decisionRegistry.js";
import { createWorldReadLedger } from "./ledger.js";
import type { CreateWorldRuntimeInput } from "./runtime.js";

export interface ComposeWorldRuntimeInput {
  readonly runId: string;
  readonly principalResolver?: WorldGrantPrincipalResolver;
  readonly worldInstanceId: string;
  readonly world: SimfileWorld;
  readonly surfaceRegistry: WorldSurfaceRegistry;
  readonly session: DynamicsSession;
  readonly maxEntriesPerPrincipal?: number;
  readonly maxPrincipals?: number;
}

/** Builds the complete six-field host-owned runtime composition. */
export const composeWorldRuntimeInput = (
  input: ComposeWorldRuntimeInput
): CreateWorldRuntimeInput => {
  const grants = composeWorldGrants({
    runId: input.runId,
    principalResolver: input.principalResolver,
    surfaceRegistry: input.surfaceRegistry,
    world: input.world,
    worldInstanceId: input.worldInstanceId,
  });
  return Object.freeze({
    dynamics: input.session,
    surfaceRegistry: input.surfaceRegistry,
    capabilityManifests: grants.artifacts,
    boundGrants: grants.boundGrants,
    decisionRegistry: createDecisionRegistry({
      runId: input.runId,
      worldInstanceId: input.worldInstanceId,
      tokenDigestKey: randomBytes(32),
    }),
    readLedger: createWorldReadLedger({
      maxEntriesPerPrincipal: input.maxEntriesPerPrincipal,
      maxPrincipals: input.maxPrincipals,
    }),
  });
};
