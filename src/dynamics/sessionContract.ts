import type { DynamicsBuildReceipt } from "./buildReceipt.js";
import type {
  DynamicsActionIngressEvidence,
  DynamicsActionQueueReceipt,
  DynamicsObservation,
  DynamicsProvenance,
  DynamicsSessionSnapshot,
  DynamicsSpatialFrame,
  DynamicsStepResult,
  ReadonlyDynamicsJsonObject,
} from "./types.js";

export interface CreateDynamicsSessionOptions {
  buildReceipt: DynamicsBuildReceipt;
  config: Record<string, unknown>;
  provenance: DynamicsProvenance;
  seed: string;
  simSecondsPerTick: number;
}

/**
 * Host-owned facade returned only by loadDynamicsSession(). Callers can queue
 * authenticated envelopes, observe exact granted senses, step, and checkpoint;
 * they cannot inject a provider or forge provenance through construction.
 */
export interface DynamicsSession {
  readonly buildReceipt: DynamicsBuildReceipt;
  readonly integration: ReadonlyDynamicsJsonObject;
  readonly nextTick: number;
  readonly provenance: DynamicsProvenance;
  observe(value: unknown): DynamicsObservation;
  queueAction(value: unknown): DynamicsActionQueueReceipt;
  readActionIngressEvidence(afterOrdinal: number): readonly DynamicsActionIngressEvidence[];
  acknowledgeActionIngressEvidence(throughOrdinal: number): void;
  restore(value: unknown): void;
  snapshot(): DynamicsSessionSnapshot;
  /** `undefined` when the provider declares no spatial projection. */
  spatial(): DynamicsSpatialFrame | undefined;
  step(): DynamicsStepResult;
}
