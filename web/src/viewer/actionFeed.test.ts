import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { participantRef, summarizeActions } from "./actionFeed.js";
import { actionsAtTick } from "./actionLog.js";
import type { RunTimeline, TimelineEvent } from "../store/timeline.js";

const baseEvent = (overrides: Partial<TimelineEvent>): TimelineEvent => ({
  t: 0,
  eventId: "event:base",
  authority: "dynamics",
  streamId: "causal:main",
  seq: 1,
  type: "dynamics.action.queued",
  viewClass: "other",
  recordedAt: "2026-08-01T00:00:00.000Z",
  subjects: [],
  causes: [],
  payload: {},
  ...overrides,
});

const queued = ({
  actId,
  eventId,
  t,
  tick,
  sequence,
  participant,
  actor,
  action,
  target,
}: {
  actId: string;
  eventId: string;
  t: number;
  tick: number;
  sequence?: number;
  participant: string;
  actor: string;
  action: string;
  target?: string;
}): TimelineEvent =>
  baseEvent({
    t,
    eventId,
    seq: t + 1,
    payload: {
      attempt: {
        act_id: actId,
        action,
        actor,
        at_tick: tick,
        principal_id: participant,
        ...(target ? { target } : {}),
        input: {},
      },
      receipt: {
        act_id: actId,
        apply_tick: tick,
        queued: true,
        ...(sequence !== undefined ? { sequence } : {}),
      },
    },
  });

const result = ({
  accepted,
  actId,
  eventId,
  t,
  tick,
  sequence,
  participant,
  actor,
  action,
  target,
}: {
  accepted: boolean;
  actId: string;
  eventId: string;
  t: number;
  tick: number;
  sequence: number;
  participant: string;
  actor: string;
  action: string;
  target?: string;
}): TimelineEvent =>
  baseEvent({
    t,
    eventId,
    seq: t + 1,
    type: accepted ? "dynamics.action.applied" : "dynamics.action.rejected_by_mechanics",
    payload: {
      accepted,
      act_id: actId,
      action,
      actor,
      apply_tick: tick,
      principal_id: participant,
      sequence,
      ...(target ? { target } : {}),
    },
  });

const timeline = (events: TimelineEvent[]): RunTimeline => ({
  version: "simfile.run-timeline.v1",
  runId: "run:fixture",
  elements: [],
  events,
});

describe("actionsAtTick", () => {
  it("joins accepted and mechanics-rejected actions using result ids and sequence order", () => {
    const events = [
      queued({
        actId: "act:accepted",
        eventId: "event:attempt:accepted",
        t: 0,
        tick: 4,
        sequence: 2,
        participant: "principal:alpha",
        actor: "object:body.alpha",
        action: "advance",
        target: "unit:beta",
      }),
      queued({
        actId: "act:rejected",
        eventId: "event:attempt:rejected",
        t: 1,
        tick: 4,
        sequence: 1,
        participant: "principal:beta",
        actor: "principal:beta",
        action: "transfer",
        target: "unit:alpha",
      }),
      result({
        accepted: true,
        actId: "act:accepted",
        eventId: "event:result:accepted",
        t: 2,
        tick: 4,
        sequence: 2,
        participant: "principal:alpha",
        actor: "object:body.alpha",
        action: "advance",
        target: "unit:beta",
      }),
      result({
        accepted: false,
        actId: "act:rejected",
        eventId: "event:result:rejected",
        t: 3,
        tick: 4,
        sequence: 1,
        participant: "principal:beta",
        actor: "principal:beta",
        action: "transfer",
        target: "unit:alpha",
      }),
    ];

    assert.deepEqual(actionsAtTick(timeline(events), 4), [
      {
        eventId: "event:result:rejected",
        t: 3,
        actId: "act:rejected",
        tick: 4,
        participant: "principal:beta",
        verb: "transfer",
        target: "unit:alpha",
        input: {},
        outcome: "rejected",
        phase: "action",
        detail: "by mechanics",
        sequence: 1,
      },
      {
        eventId: "event:result:accepted",
        t: 2,
        actId: "act:accepted",
        tick: 4,
        participant: "principal:alpha",
        actor: "object:body.alpha",
        verb: "advance",
        target: "unit:beta",
        input: {},
        outcome: "accepted",
        phase: "action",
        sequence: 2,
      },
    ]);
  });

  it("returns an empty array for a timeline without actions and for an undefined tick", () => {
    const empty = timeline([]);
    assert.deepEqual(actionsAtTick(empty, 3), []);
    assert.deepEqual(actionsAtTick(empty, undefined), []);
  });

  it("does not leak actions from another tick", () => {
    const events = [
      queued({
        actId: "act:first",
        eventId: "event:first",
        t: 0,
        tick: 8,
        sequence: 1,
        participant: "principal:alpha",
        actor: "principal:alpha",
        action: "wait",
      }),
      queued({
        actId: "act:next",
        eventId: "event:next",
        t: 1,
        tick: 9,
        sequence: 1,
        participant: "principal:beta",
        actor: "principal:beta",
        action: "observe",
      }),
    ];
    assert.deepEqual(actionsAtTick(timeline(events), 8).map((row) => row.actId), ["act:first"]);
  });

  it("renders an ingress rejection once without inventing an accepted result", () => {
    const ingress = queued({
      actId: "act:ingress",
      eventId: "event:ingress",
      t: 0,
      tick: 2,
      sequence: 1,
      participant: "principal:alpha",
      actor: "principal:alpha",
      action: "signal",
      target: "unit:beta",
    });
    ingress.type = "dynamics.action.rejected_at_ingress";
    ingress.payload = {
      ...(ingress.payload as Record<string, unknown>),
      receipt: { act_id: "act:ingress", apply_tick: 2, queued: false, sequence: 1 },
    };

    const rows = actionsAtTick(timeline([ingress]), 2);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.outcome, "rejected");
    assert.equal(rows[0]?.detail, "at ingress");
    assert.equal(rows[0]?.eventId, "event:ingress");
  });

  it("marks a queued attempt pending when no result is recorded", () => {
    const attempt = queued({
      actId: "act:pending",
      eventId: "event:pending",
      t: 0,
      tick: 6,
      sequence: 1,
      participant: "principal:alpha",
      actor: "object:body.alpha",
      action: "hold",
    });
    const rows = actionsAtTick(timeline([attempt]), 6);
    assert.equal(rows[0]?.outcome, "pending");
    assert.equal(rows[0]?.detail, "queued, no result recorded");
  });

  it("skips malformed action payloads without throwing", () => {
    const malformed = [
      baseEvent({ eventId: "event:null", payload: null }),
      baseEvent({ eventId: "event:string", payload: "garbage" }),
      baseEvent({ eventId: "event:missing", payload: { attempt: { action: "wait" } } }),
    ];
    assert.doesNotThrow(() => actionsAtTick(timeline(malformed), 1));
    assert.deepEqual(actionsAtTick(timeline(malformed), 1), []);
  });

  it("orders sequenced rows before unsequenced rows, then by t and source index", () => {
    const events = [
      queued({
        actId: "act:unsequenced-later",
        eventId: "event:unsequenced-later",
        t: 3,
        tick: 10,
        participant: "principal:first",
        actor: "principal:first",
        action: "first",
      }),
      queued({
        actId: "act:sequence-two",
        eventId: "event:sequence-two",
        t: 1,
        tick: 10,
        sequence: 2,
        participant: "principal:second",
        actor: "principal:second",
        action: "second",
      }),
      queued({
        actId: "act:unsequenced-first-source",
        eventId: "event:unsequenced-first-source",
        t: 2,
        tick: 10,
        participant: "principal:third",
        actor: "principal:third",
        action: "third",
      }),
      queued({
        actId: "act:sequence-one",
        eventId: "event:sequence-one",
        t: 4,
        tick: 10,
        sequence: 1,
        participant: "principal:fourth",
        actor: "principal:fourth",
        action: "fourth",
      }),
      queued({
        actId: "act:unsequenced-second-source",
        eventId: "event:unsequenced-second-source",
        t: 2,
        tick: 10,
        participant: "principal:fifth",
        actor: "principal:fifth",
        action: "fifth",
      }),
    ];

    assert.deepEqual(actionsAtTick(timeline(events), 10).map(({ actId }) => actId), [
      "act:sequence-one",
      "act:sequence-two",
      "act:unsequenced-first-source",
      "act:unsequenced-second-source",
      "act:unsequenced-later",
    ]);
  });
});

describe("participantRef", () => {
  it("returns the first enumerated exact or agent-prefixed participant ref", () => {
    const run = timeline([]);
    run.elements = [
      { ref: "agent:principal:alpha", kind: "agent", label: "Alpha" },
      { ref: "principal:alpha", kind: "agent", label: "Duplicate Alpha" },
      { ref: "principal:beta", kind: "agent", label: "Beta" },
    ];

    assert.equal(participantRef(run, "principal:alpha"), "agent:principal:alpha");
    assert.equal(participantRef(run, "principal:beta"), "principal:beta");
  });

  it("returns undefined when the timeline does not enumerate the participant", () => {
    const run = timeline([]);
    run.elements = [{ ref: "agent:principal:alpha", kind: "agent", label: "Alpha" }];

    assert.equal(participantRef(run, "principal:missing"), undefined);
  });
});

describe("summarizeActions", () => {
  it("counts every outcome", () => {
    const rows = [
      ...actionsAtTick(timeline([
        queued({
          actId: "act:pending",
          eventId: "event:pending",
          t: 0,
          tick: 1,
          sequence: 1,
          participant: "principal:alpha",
          actor: "principal:alpha",
          action: "wait",
        }),
      ]), 1),
    ];
    assert.deepEqual(
      summarizeActions([
        ...rows,
        { ...rows[0]!, eventId: "event:accepted", outcome: "accepted" },
        { ...rows[0]!, eventId: "event:rejected", outcome: "rejected" },
        { ...rows[0]!, eventId: "event:matched", outcome: "matched" },
        { ...rows[0]!, eventId: "event:unmatched", outcome: "unmatched" },
      ]),
      {
        abandoned: 0,
        accepted: 1,
        expired: 0,
        fulfilled: 0,
        matched: 1,
        pending: 1,
        rejected: 1,
        unmatched: 1,
      },
    );
  });
});
