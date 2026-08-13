import { cloneDynamicsJsonObject } from "./canonicalJson.js";
import { DYNAMICS_LIMITS } from "./limits.js";
import type {
  DynamicsCommitmentOutcomeDraft,
  DynamicsCommitmentOutcomeStatus,
} from "./types.js";

const ADDRESS_PATTERN = /^[a-z][a-z0-9_-]*(?::[a-z][a-z0-9_.-]*)+$/u;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_-]*(?::[a-z0-9][a-z0-9_.-]*)+$/u;
const OUTCOMES = new Set<DynamicsCommitmentOutcomeStatus>([
  "fulfilled",
  "expired",
  "abandoned",
  "matched",
  "unmatched",
]);
/** Addressed outcomes state whether the world matched a declared expectation. */
const COUNTERPARTY_REQUIRED = new Set<DynamicsCommitmentOutcomeStatus>([
  "matched",
  "unmatched",
]);
/** Unaddressed outcomes are a participant's own commitment, so none is named. */
const COUNTERPARTY_FORBIDDEN = new Set<DynamicsCommitmentOutcomeStatus>([
  "fulfilled",
  "abandoned",
]);

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void => {
  const allowed = new Set(expected);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new Error(`${path} contains unknown field ${String(key)}`);
    }
  }
};

const boundedCanonical = (
  value: unknown,
  pattern: RegExp,
  path: string,
): string => {
  if (typeof value !== "string" || value.length === 0
    || value.length > DYNAMICS_LIMITS.identifier_code_units
    || value !== value.trim() || !pattern.test(value)) {
    throw new Error(`${path} must be a canonical identifier`);
  }
  return value;
};

export const parseDynamicsCommitmentOutcomeDraft = (
  value: unknown,
  path = "dynamics commitment outcome",
): DynamicsCommitmentOutcomeDraft => {
  const record = cloneDynamicsJsonObject(value, path);
  exactKeys(record, [
    "commitment_id",
    "counterparty",
    "declaration_action_sequence",
    "outcome",
    "participant",
  ], path);
  if (!Number.isSafeInteger(record.declaration_action_sequence)
    || (record.declaration_action_sequence as number) <= 0) {
    throw new Error(`${path}.declaration_action_sequence must be positive`);
  }
  const outcome = record.outcome as DynamicsCommitmentOutcomeStatus;
  if (!OUTCOMES.has(outcome)) {
    throw new Error(`${path}.outcome is invalid`);
  }
  const addressed = Object.hasOwn(record, "counterparty");
  if (addressed && COUNTERPARTY_FORBIDDEN.has(outcome)) {
    throw new Error(`${path}.counterparty is not admitted for ${outcome}`);
  }
  if (!addressed && COUNTERPARTY_REQUIRED.has(outcome)) {
    throw new Error(`${path}.counterparty is required for ${outcome}`);
  }
  const participant = boundedCanonical(
    record.participant,
    ADDRESS_PATTERN,
    `${path}.participant`,
  );
  const counterparty = addressed
    ? boundedCanonical(
      record.counterparty,
      ADDRESS_PATTERN,
      `${path}.counterparty`,
    )
    : undefined;
  if (counterparty === participant) {
    throw new Error(`${path}.counterparty must not be the participant`);
  }
  return {
    commitment_id: boundedCanonical(
      record.commitment_id,
      IDENTIFIER_PATTERN,
      `${path}.commitment_id`,
    ),
    ...(counterparty === undefined ? {} : { counterparty }),
    declaration_action_sequence: record.declaration_action_sequence as number,
    outcome,
    participant,
  };
};

export const parseDynamicsCommitmentOutcomeDrafts = (
  value: unknown,
  path = "dynamics step result.commitment_outcomes",
): DynamicsCommitmentOutcomeDraft[] => {
  if (!Array.isArray(value)
    || value.length > DYNAMICS_LIMITS.events_per_tick) {
    throw new Error(`${path} exceeds the per-tick outcome limit`);
  }
  const outcomes = value.map((entry, index) =>
    parseDynamicsCommitmentOutcomeDraft(entry, `${path}[${index}]`));
  const ids = new Set<string>();
  for (const outcome of outcomes) {
    if (ids.has(outcome.commitment_id)) {
      throw new Error(`${path} contains duplicate commitment id ${outcome.commitment_id}`);
    }
    ids.add(outcome.commitment_id);
  }
  return outcomes;
};
