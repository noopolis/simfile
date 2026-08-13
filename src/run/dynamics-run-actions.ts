import type {
  DynamicsActionAttempt,
  DynamicsActionIngressRecord,
  DynamicsActionResult
} from "../dynamics/types.js";
import type { DynamicsRunActionSourceProvenance } from
  "../dynamics/runActionSource.js";

export const DYNAMICS_RUN_ACTION_INGRESS_VERSION =
  "simfile.dynamics-run-action-ingress.v1" as const;
export const DYNAMICS_RUN_ACTION_RESULT_VERSION =
  "simfile.dynamics-run-action-result.v1" as const;
export const DYNAMICS_RUN_STEP_RECORD_VERSION =
  "simfile.dynamics-run-step.v1" as const;

export const NONE_DYNAMICS_RUN_DECISION_SOURCE = Object.freeze({
  actors: Object.freeze([]) as readonly string[],
  kind: "none" as const,
  model_decisions: false as const,
  provenance: "none" as const
});

export type DynamicsRunDecisionSource =
  | typeof NONE_DYNAMICS_RUN_DECISION_SOURCE
  | Readonly<{
    actors: readonly string[];
    kind: "agent" | "controller";
    live_acceptance: boolean;
    model_decisions: boolean;
    provenance: DynamicsRunActionSourceProvenance;
  }>;

export interface DynamicsRunActionSourceEvidence {
  readonly id: string;
  readonly live_acceptance: boolean;
  readonly provenance: DynamicsRunActionSourceProvenance;
}

export interface DynamicsRunActionIngressRecord {
  readonly attempt: DynamicsActionAttempt;
  readonly receipt: DynamicsActionIngressRecord["receipt"];
  readonly source: DynamicsRunActionSourceEvidence;
  readonly version: typeof DYNAMICS_RUN_ACTION_INGRESS_VERSION;
}

export interface DynamicsRunActionResultRecord {
  readonly result: DynamicsActionResult;
  readonly source: DynamicsRunActionSourceEvidence;
  readonly version: typeof DYNAMICS_RUN_ACTION_RESULT_VERSION;
}

export interface DynamicsRunDecisionEvidence {
  readonly actors: Set<string>;
  readonly origins: Set<DynamicsActionAttempt["origin"]>;
  provenance: DynamicsRunActionSourceProvenance;
  live_acceptance: boolean;
  appliedResults: number;
  ingressRecords: number;
  results: number;
}

const codePointOrder = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const createDynamicsRunDecisionEvidence = (source?: Readonly<{
  provenance: DynamicsRunActionSourceProvenance;
}>): DynamicsRunDecisionEvidence => ({
  actors: new Set(),
  origins: new Set(),
  provenance: source?.provenance ?? "scripted",
  live_acceptance: false,
  appliedResults: 0,
  ingressRecords: 0,
  results: 0
});

export const recordDynamicsRunDecisionIngress = (
  evidence: DynamicsRunDecisionEvidence,
  ingress: DynamicsActionIngressRecord
): void => {
  evidence.actors.add(ingress.attempt.actor);
  evidence.origins.add(ingress.attempt.origin);
  evidence.ingressRecords += 1;
};

export const recordDynamicsRunDecisionResult = (
  evidence: DynamicsRunDecisionEvidence,
  result: DynamicsActionResult
): void => {
  evidence.results += 1;
  if (result.accepted) evidence.appliedResults += 1;
};

export const joinDynamicsRunResult = (
  ingress: DynamicsActionIngressRecord,
  result: DynamicsActionResult
): DynamicsActionResult => {
  const attempt = ingress.attempt;
  if (
    !ingress.receipt.queued
    || ingress.receipt.sequence !== result.sequence
    || ingress.receipt.apply_tick !== result.apply_tick
    || attempt.act_id !== result.act_id
    || attempt.action !== result.action
    || attempt.actor !== result.actor
    || attempt.origin !== result.origin
    || attempt.principal_id !== result.principal_id
    || attempt.target !== result.target
  ) {
    throw new Error("dynamics action result provenance mismatch");
  }
  return result;
};

export const deriveDynamicsRunDecisionSource = (
  evidence: DynamicsRunDecisionEvidence
): DynamicsRunDecisionSource => {
  if (evidence.ingressRecords === 0 && evidence.results === 0) {
    return NONE_DYNAMICS_RUN_DECISION_SOURCE;
  }
  for (const origin of evidence.origins) {
    if (origin === "external" || origin === "replay") {
      throw new Error(
        `unsupported local participant action origin ${origin}`
      );
    }
  }
  if (evidence.origins.size !== 1) {
    throw new Error("mixed participant action origins are not representable");
  }
  const origin = evidence.origins.values().next().value;
  if (origin !== "controller" && origin !== "agentic") {
    throw new Error("participant decision source has no recorded origin");
  }
  const actors = Object.freeze(
    [...evidence.actors].sort(codePointOrder)
  );
  return Object.freeze({
    actors,
    kind: origin === "controller" ? "controller" : "agent",
    live_acceptance: evidence.live_acceptance,
    model_decisions: evidence.provenance === "model",
    provenance: evidence.provenance
  });
};

export const assertDynamicsRunDecisionInvariant = (input: Readonly<{
  decisionSource: DynamicsRunDecisionSource;
  evidence: DynamicsRunDecisionEvidence;
}>): void => {
  if (input.decisionSource.kind === "none" && input.evidence.appliedResults > 0) {
    throw new Error(
      'dynamics run decision_source "none" cannot coexist with an applied action'
    );
  }
  const empty = input.evidence.ingressRecords === 0 && input.evidence.results === 0;
  if ((input.decisionSource.kind === "none") !== empty) {
    throw new Error(
      "dynamics run decision_source none must exactly represent action silence"
    );
  }
};

export const resolveDynamicsRunProviderActionCauses = (
  lookup: (sequence: number) => Promise<string | undefined>,
  sequences: readonly number[]
): Promise<string[]> => Promise.all(sequences.map(async (sequence) => {
  const cause = await lookup(sequence);
  if (cause !== undefined) return cause;
  throw new Error(
    `dynamics provider event has unknown accepted action sequence ${sequence}`
  );
}));
