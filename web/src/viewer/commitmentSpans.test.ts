import assert from "node:assert/strict";
import test from "node:test";

import type { RunTimeline, TimelineEvent } from "../store/timeline.js";
import {
  commitmentSpanInForceAt,
  commitmentSpanSummary,
  commitmentSpans,
  commitmentsInForceAtTick,
} from "./commitmentSpans.js";

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

const declaration = (
  actId: string,
  tick: number,
  sequence: number,
  target: string,
  accepted = true,
): TimelineEvent[] => [
  event("dynamics.action.queued", `event:queued:${sequence}`, tick * 2, {
    attempt: {
      act_id: actId,
      action: "commit",
      actor: "object:participant.alpha",
      at_tick: tick,
      input: {},
      principal_id: "controller:alpha-mind",
      target,
    },
    receipt: { act_id: actId, apply_tick: tick, queued: true, sequence },
  }),
  event("dynamics.action.applied", `event:applied:${sequence}`, tick * 2 + 1, {
    accepted,
    act_id: actId,
    action: "commit",
    actor: "object:participant.alpha",
    apply_tick: tick,
    principal_id: "controller:alpha-mind",
    sequence,
    target,
  }),
];

const outcome = (
  eventId: string,
  tick: number,
  sequence: number,
  value: Record<string, unknown>,
): TimelineEvent =>
  event("dynamics.commitment.outcome", eventId, tick * 2, {
    commitment_id: `commitment:alpha:${sequence}`,
    declaration_action_sequence: sequence,
    participant: "object:participant.alpha",
    provenance: "mechanical",
    tick,
    ...value,
  });

const timeline = (events: readonly TimelineEvent[]): RunTimeline => ({
  elements: [],
  events: [...events],
  runId: "run:spans",
  version: "simfile.run-timeline.v1",
});

test("a commitment is a span from its declaration to its terminal fact", () => {
  const run = timeline([
    ...declaration("act:1", 20, 3, "object:participant.beta"),
    outcome("event:outcome:3", 80, 3, {
      counterparty: "object:participant.beta",
      outcome: "matched",
    }),
  ]);
  assert.deepEqual(commitmentSpans(run), [{
    actId: "act:1",
    counterparty: "object:participant.beta",
    declaredAtTick: 20,
    eventId: "event:queued:3",
    participant: "controller:alpha-mind",
    actor: "object:participant.alpha",
    resolution: {
      commitmentId: "commitment:alpha:3",
      eventId: "event:outcome:3",
      outcome: "matched",
      t: 160,
      tick: 80,
    },
    sequence: 3,
    t: 40,
    target: "object:participant.beta",
    verb: "commit",
  }]);
  const [span] = commitmentSpans(run);
  assert.ok(span);
  // The whole point: in force for every tick of the span, not only its edges.
  assert.deepEqual(
    [19, 20, 21, 50, 79, 80, 81].map((tick) =>
      commitmentSpanInForceAt(span, tick)),
    [false, true, true, true, true, true, false],
  );
  assert.deepEqual(
    commitmentsInForceAtTick(run, 50).map(commitmentSpanSummary),
    [
      "controller:alpha-mind → object:participant.beta · commit"
      + " · declared t20 · matched t80",
    ],
  );
  assert.deepEqual(commitmentsInForceAtTick(run, undefined), []);
  assert.deepEqual(commitmentsInForceAtTick(run, 81), []);
});

test("a commitment the run never terminated is reported standing", () => {
  const run = timeline(declaration("act:1", 5, 2, "object:participant.alpha"));
  const [span] = commitmentSpans(run);
  assert.ok(span);
  assert.equal(Object.hasOwn(span, "resolution"), false);
  assert.equal(Object.hasOwn(span, "counterparty"), false);
  assert.equal(commitmentSpanInForceAt(span, 4), false);
  assert.equal(commitmentSpanInForceAt(span, 5), true);
  assert.equal(commitmentSpanInForceAt(span, 9_999), true);
  assert.equal(
    commitmentSpanSummary(span),
    "controller:alpha-mind · commit · declared t5 · standing",
  );
});

test("only admitted declarations open a span", () => {
  const run = timeline([
    ...declaration("act:1", 5, 2, "object:participant.alpha", false),
    ...declaration("act:2", 6, 3, "object:participant.alpha"),
  ]);
  assert.deepEqual(commitmentSpans(run).map(({ actId }) => actId), ["act:2"]);
});

test("spans are ordered by declaration and terminal facts join by sequence", () => {
  const run = timeline([
    ...declaration("act:2", 40, 9, "object:participant.beta"),
    ...declaration("act:1", 10, 4, "object:participant.alpha"),
    outcome("event:outcome:4", 60, 4, { outcome: "abandoned" }),
    outcome("event:outcome:9", 90, 9, {
      counterparty: "object:participant.beta",
      outcome: "expired",
    }),
  ]);
  assert.deepEqual(commitmentSpans(run).map(commitmentSpanSummary), [
    "controller:alpha-mind · commit · declared t10 · abandoned t60",
    "controller:alpha-mind → object:participant.beta · commit"
    + " · declared t40 · expired t90",
  ]);
  // Both stand together at tick 50 — the feed at a mid-run tick is not empty.
  assert.deepEqual(
    commitmentsInForceAtTick(run, 50).map(({ actId }) => actId),
    ["act:1", "act:2"],
  );
  assert.deepEqual(
    commitmentsInForceAtTick(run, 70).map(({ actId }) => actId),
    ["act:2"],
  );
});

test("a duplicated terminal fact closes the span at the earliest record", () => {
  const run = timeline([
    ...declaration("act:1", 10, 4, "object:participant.alpha"),
    outcome("event:outcome:late", 70, 4, { outcome: "expired" }),
    outcome("event:outcome:early", 50, 4, { outcome: "fulfilled" }),
  ]);
  assert.deepEqual(commitmentSpans(run).map(commitmentSpanSummary), [
    "controller:alpha-mind · commit · declared t10 · fulfilled t50",
  ]);
});

test("terminal records the run did not fully state are ignored", () => {
  for (const broken of [
    { declaration_action_sequence: 0 },
    { declaration_action_sequence: 1.5 },
    { outcome: "accepted" },
    { commitment_id: undefined },
    { tick: undefined },
  ]) {
    const run = timeline([
      ...declaration("act:1", 10, 4, "object:participant.alpha"),
      outcome("event:outcome:4", 50, 4, { outcome: "expired", ...broken }),
    ]);
    const [span] = commitmentSpans(run);
    assert.ok(span);
    assert.equal(Object.hasOwn(span, "resolution"), false);
  }
});
