import type { Simfile } from "../schema/model.js";
import {
  loadDynamicsCore,
  type LoadDynamicsArtifactLifecycleOptions,
  type LoadDynamicsSessionOptions
} from "./loadCore.js";
import type { DynamicsSession } from "./session.js";

export type { DynamicsBuildReceipt } from "./buildReceipt.js";
export type {
  LoadDynamicsArtifactLifecycleOptions,
  LoadDynamicsSessionOptions
} from "./loadCore.js";

/**
 * Prepares, receipts, persists, verifies, and imports one trusted authored
 * provider as a sealed bundle. The scratch lifecycle is removed before this
 * function settles; a requested evidence pair remains caller-owned.
 */
export const loadDynamicsSession = async (
  simfile: Simfile,
  options: LoadDynamicsSessionOptions
): Promise<DynamicsSession | undefined> => {
  const loaded = await loadDynamicsCore(simfile, options);
  return loaded?.session;
};
