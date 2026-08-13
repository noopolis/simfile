import assert from "node:assert/strict";
import test from "node:test";

import {
  parseDynamicsCommitmentOutcomeDraft,
  parseDynamicsCommitmentOutcomeDrafts,
} from "./commitmentOutcomes.js";
import { DYNAMICS_LIMITS } from "./limits.js";
import { parseDynamicsStepResult } from "./validation.js";

const valid = () => ({
  commitment_id: "commitment:alpha:1",
  declaration_action_sequence: 1,
  outcome: "fulfilled",
  participant: "object:participant.alpha",
});

test("parses the exact terminal commitment draft", () => {
  assert.deepEqual(parseDynamicsCommitmentOutcomeDraft(valid()), valid());
  for (const mutate of [
    (value: Record<string, unknown>) => { value.outcome = "pending"; },
    (value: Record<string, unknown>) => { value.reason = "because"; },
    (value: Record<string, unknown>) => { value.declaration_action_sequence = 0; },
    (value: Record<string, unknown>) => { value.commitment_id = ""; },
    (value: Record<string, unknown>) => { value.tick = 4; },
    (value: Record<string, unknown>) => { value.provenance = "mechanical"; },
  ]) {
    const value = valid() as Record<string, unknown>;
    mutate(value);
    assert.throws(() => parseDynamicsCommitmentOutcomeDraft(value));
  }
});

test("rejects duplicate commitment ids within one step", () => {
  assert.throws(
    () => parseDynamicsCommitmentOutcomeDrafts([
      valid(),
      { ...valid(), outcome: "expired" },
    ]),
    /duplicate commitment id/u,
  );
  assert.deepEqual(
    parseDynamicsCommitmentOutcomeDrafts([
      valid(),
      { ...valid(), commitment_id: "commitment:beta:2", outcome: "abandoned" },
    ]).map(({ outcome }) => outcome),
    ["fulfilled", "abandoned"],
  );
});

test("a step result counts commitment outcomes against the per-tick event limit", () => {
  const stepResult = (events: number, outcomes: number) => ({
    action_results: [],
    commitment_outcomes: Array.from({ length: outcomes }, (_unused, index) => ({
      ...valid(),
      commitment_id: `commitment:alpha:${index + 1}`,
      declaration_action_sequence: index + 1,
    })),
    events: Array.from({ length: events }, () => ({
      cause_action_sequences: [],
      kind: "probe",
      payload: {},
      source: "object:participant.alpha",
      target: "object:participant.alpha",
    })),
    tick: 0,
  });
  const limit = DYNAMICS_LIMITS.events_per_tick;
  assert.equal(
    parseDynamicsStepResult(stepResult(limit - 2, 2), 0, [], 1)
      .commitment_outcomes?.length,
    2,
  );
  assert.throws(
    () => parseDynamicsStepResult(stepResult(limit - 1, 2), 0, [], 1),
    /events and commitment outcomes exceed the per-tick event limit/u,
  );
});

const addressed = () => ({
  commitment_id: "commitment:alpha:2",
  counterparty: "object:participant.beta",
  declaration_action_sequence: 2,
  outcome: "matched",
  participant: "object:participant.alpha",
});

test("admits a counterparty only where an addressed outcome allows one", () => {
  assert.deepEqual(parseDynamicsCommitmentOutcomeDraft(addressed()), addressed());
  assert.deepEqual(
    parseDynamicsCommitmentOutcomeDraft({ ...addressed(), outcome: "unmatched" }),
    { ...addressed(), outcome: "unmatched" },
  );
  // Optional for an expired declaration: it may or may not have been addressed.
  assert.deepEqual(
    parseDynamicsCommitmentOutcomeDraft({ ...addressed(), outcome: "expired" }),
    { ...addressed(), outcome: "expired" },
  );
  assert.deepEqual(
    parseDynamicsCommitmentOutcomeDraft({ ...valid(), outcome: "expired" }),
    { ...valid(), outcome: "expired" },
  );
});

test("refuses a counterparty that contradicts the outcome kind", () => {
  for (const outcome of ["fulfilled", "abandoned"]) {
    assert.throws(
      () => parseDynamicsCommitmentOutcomeDraft({ ...addressed(), outcome }),
      /counterparty is not admitted/u,
    );
  }
  for (const outcome of ["matched", "unmatched"]) {
    assert.throws(
      () => parseDynamicsCommitmentOutcomeDraft({ ...valid(), outcome }),
      /counterparty is required/u,
    );
  }
  assert.throws(
    () => parseDynamicsCommitmentOutcomeDraft({
      ...addressed(),
      counterparty: addressed().participant,
    }),
    /counterparty must not be the participant/u,
  );
  assert.throws(() => parseDynamicsCommitmentOutcomeDraft({
    ...addressed(),
    counterparty: "Not An Address",
  }));
});
