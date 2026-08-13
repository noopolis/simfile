import {
  constructWorldServiceEntrypoint,
  type CreateWorldServiceEntrypointInput,
  type WorldServiceEntrypoint,
} from "./worldServiceConstruction.js";

/** Runtime-composer authority surface. Fixture composers import this only from the emitted sidecar entrypoint. */
export { createDynamicsSession } from "../dynamics/session.js";
export { parseWorldSurfaceDefinition } from "../world-surface/index.js";
export { compileCapabilityManifests } from "../world/capabilityManifest.js";
export { createDecisionRegistry } from "../world/decisionRegistry.js";
export { bindWorldGrants } from "../world/grants.js";
export { createWorldReadLedger } from "../world/ledger.js";
export { composeWorldRuntimeInput } from "../world/runtimeComposition.js";
export { WORLD_DECISION_CLAIM_CAPABILITY } from "../world/decisionClaim.js";
export { readWorldRuntimeClockAuthority } from "../world/clockAuthority.js";
export type { WorldDynamicsTickRecord } from "../world/clockAuthority.js";
export { readWorldRuntimeControllerAuthority } from "../world/controllerAuthority.js";
export { registerWorldBoundaryObserver } from "../world/boundaryObserver.js";
export { readWorldRuntimeCheckpointCoordinator } from "../world/checkpointRuntime.js";
export type { WorldCheckpoint } from "../world/checkpoint.js";
export { createCausalRecorder } from "../runtime/causalRecording.js";
export type { CausalRecorder } from "../runtime/causalRecording.js";
export { createMoltnetMachineClient } from "../moltnet/machine/client.js";
export type { ResolvedWorldGrant } from "../world/grants.js";
export type { CreateWorldRuntimeInput, WorldRuntime } from "../world/runtime.js";

export { startWorldServiceSidecar } from "./sidecarEntrypoint.js";
export {
  WORLD_SIDECAR_RUNTIME_ABI,
  type ProveWorldSidecarReadiness,
  type StartWorldSidecarController,
  type StartedWorldSidecar,
  type WorldSidecarActivation,
  type WorldSidecarBearerDeclaration,
  type WorldSidecarConfiguration,
  type WorldSidecarController,
} from "./sidecarConfiguration.js";
export type {
  CreateWorldServiceEntrypointInput,
  WorldServiceEntrypoint,
} from "./worldServiceConstruction.js";

/** Constructs the generic runtime and unbound adapters; deployment owns lifecycle. */
export const createWorldServiceEntrypoint = (
  input: CreateWorldServiceEntrypointInput,
): WorldServiceEntrypoint => {
  const entrypoint = constructWorldServiceEntrypoint(input);
  return Object.freeze({
    jsonListener: entrypoint.jsonListener,
    mcpListener: entrypoint.mcpListener,
  });
};
