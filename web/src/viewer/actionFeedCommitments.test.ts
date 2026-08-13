import assert from "node:assert/strict";
import test from "node:test";

import type { RunTimeline, TimelineEvent } from "../store/timeline.js";
import { actionsAtTick } from "./actionLog.js";

const event = (
  type: string,
  eventId: string,
  t: number,
  payload: unknown,
): TimelineEvent => ({
  authority: "dynamics",
  causes: [],
  eventId,
  payload,
  recordedAt: "2026-08-01T00:00:00.000Z",
  seq: t + 1,
  streamId: "causal:main",
  subjects: [],
  t,
  type,
  viewClass: "other",
});

const timeline = (outcomePayload: unknown): RunTimeline => ({
  elements: [],
  events: [
    event("dynamics.action.queued", "event:queued", 0, {
      attempt: {
        act_id: "controller:alpha-mind:0",
        action: "commit",
        actor: "object:participant.alpha",
        at_tick: 0,
        input: {},
        principal_id: "controller:alpha-mind",
        target: "object:participant.alpha",
      },
      provenance: "external",
      receipt: {
        act_id: "controller:alpha-mind:0",
        apply_tick: 0,
        queued: true,
        sequence: 7,
      },
    }),
    event("dynamics.action.applied", "event:applied", 1, {
      accepted: true,
      act_id: "controller:alpha-mind:0",
      action: "commit",
      actor: "object:participant.alpha",
      apply_tick: 0,
      principal_id: "controller:alpha-mind",
      provenance: "external",
      sequence: 7,
      target: "object:participant.alpha",
    }),
    event("dynamics.commitment.outcome", "event:outcome", 9, outcomePayload),
  ],
  runId: "run:commitment",
  version: "simfile.run-timeline.v1",
});

test("joins a terminal commitment by declaration sequence at the outcome tick", () => {
  const run = timeline({
    commitment_id: "commitment:alpha:7",
    declaration_action_sequence: 7,
    outcome: "fulfilled",
    participant: "object:participant.alpha",
    provenance: "mechanical",
    tick: 12,
  });
  assert.deepEqual(actionsAtTick(run, 0).map(({ outcome, phase }) => ({
    outcome,
    phase,
  })), [{ outcome: "accepted", phase: "action" }]);
  // The resolution carries its declaration, so an observer reading it 12 ticks
  // later never meets an outcome with no way to see what it resolved.
  assert.deepEqual(actionsAtTick(run, 12), [{
    actId: "controller:alpha-mind:0",
    commitmentId: "commitment:alpha:7",
    declaration: {
      actor: "object:participant.alpha",
      eventId: "event:queued",
      participant: "controller:alpha-mind",
      t: 0,
      target: "object:participant.alpha",
      tick: 0,
      input: {},
      provenance: "external",
      verb: "commit",
    },
    eventId: "event:outcome",
    outcome: "fulfilled",
    participant: "object:participant.alpha",
    phase: "commitment",
    provenance: "mechanical",
    sequence: 7,
    t: 9,
    target: "object:participant.alpha",
    tick: 12,
    verb: "commit",
  }]);
});

test("ignores malformed, unknown, and unjoined terminal facts", () => {
  for (const malformed of [
    null,
    {},
    {
      commitment_id: "commitment:alpha:7",
      declaration_action_sequence: 8,
      outcome: "expired",
      participant: "object:participant.alpha",
      tick: 12,
    },
    {
      commitment_id: "commitment:alpha:7",
      declaration_action_sequence: 7,
      outcome: "pending",
      participant: "object:participant.alpha",
      tick: 12,
    },
  ]) assert.deepEqual(actionsAtTick(timeline(malformed), 12), []);
});

test("carries the counterparty of an addressed commitment onto the row", () => {
  const run = timeline({
    commitment_id: "pact:alpha:7",
    counterparty: "object:participant.beta",
    declaration_action_sequence: 7,
    outcome: "matched",
    participant: "object:participant.alpha",
    provenance: "mechanical",
    tick: 12,
  });
  assert.deepEqual(
    actionsAtTick(run, 12).map(({ counterparty, outcome, participant }) => ({
      counterparty,
      outcome,
      participant,
    })),
    [{
      counterparty: "object:participant.beta",
      outcome: "matched",
      participant: "object:participant.alpha",
    }],
  );
});

test("keeps an unaddressed terminal fact free of a counterparty", () => {
  const run = timeline({
    commitment_id: "pact:alpha:7",
    declaration_action_sequence: 7,
    outcome: "unmatched",
    participant: "object:participant.alpha",
    provenance: "mechanical",
    tick: 12,
  });
  assert.equal(
    Object.hasOwn(actionsAtTick(run, 12)[0]!, "counterparty"),
    false,
  );
});
