import type { LedgerEvent } from "../ledger/markers.js";

/**
 * Genre-neutral scored-task inputs: which actor's world.act on which target
 * variable counts as the submission, and which rule's firing counts as the
 * mechanical proof of correctness. Callers supply the ids; this module names
 * no fixture, world, or setting of its own.
 */
export interface ScoreSingleSubmissionInput {
  actor: string;
  target: string;
  rule: string;
}

export interface ScoreSingleSubmissionResult {
  score: 0 | 1;
  submissions: number;
  ruleFirings: number;
}

/**
 * Scores a single-submission scored task from the ledger alone. `submissions`
 * counts `world.act` events by `(actor, target)`; `ruleFirings` counts
 * `rule.fired` events by `actor === rule`. `score` is 1 iff both are exactly
 * 1 — one accepted submission, mechanically proven correct by the paired
 * rule firing. Two accepted acts (a resubmission) scores 0 even if the rule
 * fired, by design: it is discipline pressure, not a scoring bug.
 */
export const scoreSingleSubmission = (
  events: readonly LedgerEvent[],
  input: ScoreSingleSubmissionInput
): ScoreSingleSubmissionResult => {
  const submissions = events.filter((event) =>
    event.kind === "world.act" && event.actor === input.actor && event.target === input.target
  ).length;

  const ruleFirings = events.filter((event) =>
    event.kind === "rule.fired" && event.actor === input.rule
  ).length;

  const score: 0 | 1 = submissions === 1 && ruleFirings === 1 ? 1 : 0;

  return { score, submissions, ruleFirings };
};
