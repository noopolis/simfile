export const COMPOSED_RUN_PHASES = Object.freeze([
  "requested",
  "prepared",
  "world_created",
  "world_started_paused",
  "world_ready",
  "organization_started",
  "organization_ready",
  "topology_verified",
  "activated",
  "tick_1",
  "running",
  "terminal",
  "world_paused",
  "world_evidence_exported",
  "organization_evidence_exported",
  "cleaned",
  "completed",
] as const);

export type ComposedRunPhase = typeof COMPOSED_RUN_PHASES[number];

export const composedRunPhaseIndex = (phase: ComposedRunPhase): number =>
  COMPOSED_RUN_PHASES.indexOf(phase);

export const nextComposedRunPhase = (
  phase: ComposedRunPhase,
): ComposedRunPhase | null => COMPOSED_RUN_PHASES[composedRunPhaseIndex(phase) + 1] ?? null;

export interface ComposedRunClock {
  now(): string;
}

export interface ComposedRunFaultInjector {
  afterPhase?(phase: ComposedRunPhase): void | Promise<void>;
}
