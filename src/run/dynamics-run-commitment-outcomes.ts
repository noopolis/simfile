import type { DynamicsCommitmentOutcome } from "../dynamics/types.js";
import type { DynamicsRunActionSourceEvidence } from "./dynamics-run-actions.js";

export const DYNAMICS_RUN_COMMITMENT_OUTCOME_VERSION =
  "simfile.dynamics-run-commitment-outcome.v1" as const;

export interface DynamicsRunCommitmentOutcomeRecord {
  readonly version: typeof DYNAMICS_RUN_COMMITMENT_OUTCOME_VERSION;
  readonly source: DynamicsRunActionSourceEvidence;
  readonly outcome: DynamicsCommitmentOutcome;
}

export const createDynamicsRunCommitmentOutcomeRecord = (
  source: DynamicsRunActionSourceEvidence,
  outcome: DynamicsCommitmentOutcome,
): DynamicsRunCommitmentOutcomeRecord => ({
  version: DYNAMICS_RUN_COMMITMENT_OUTCOME_VERSION,
  source,
  outcome,
});
