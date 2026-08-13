import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { derivePlaybackCadence } from "../chrome/playbackCadence.js";
import type { RunTimeline, TimelineEvent } from "../store/timeline.js";
import { actionsAtTick } from "./actionLog.js";
import {
  recordedTickAtCursor,
  recordedTickOf,
  sampleAtTick,
  tickAtCursor,
  trajectoryUpToTick,
  type RunMetaVariableSample,
} from "./variableModel.js";

const clockSync = (t: number, tick: number): TimelineEvent => ({
  t,
  eventId: `clock-${tick}`,
  authority: "world",
  streamId: "world",
  seq: tick + 1,
  type: "clock.sync",
  viewClass: "clock",
  recordedAt: "2026-07-12T00:00:00.000Z",
  subjects: ["clock:global"],
  causes: [],
  payload: { tick, sim_time: tick * 60, phase: "workday" },
});

const timelineWithTicks = (ticks: number[]): RunTimeline => ({
  version: "simfile.run-timeline.v1",
  runId: "run-test",
  elements: [],
  membranes: [],
  events: ticks.map((tick, index) => clockSync(index, tick)),
});

const eventAtTick = (
  t: number,
  tick: number,
  type: string,
  payload: unknown,
): TimelineEvent => ({
  t,
  eventId: `event-${t}`,
  authority: "world",
  streamId: "world",
  seq: t + 1,
  type,
  viewClass: "other",
  recordedAt: new Date(tick * 0.02 * 1_000).toISOString(),
  subjects: [],
  causes: [],
  payload,
});

const samplesFixture: RunMetaVariableSample[] = [
  { tick: 0, simTime: 0, phase: "workday", variables: { filing_pressure: 0.7 } },
  { tick: 1, simTime: 60, phase: "workday", variables: { filing_pressure: 1 } },
  { tick: 2, simTime: 120, phase: "workday", variables: { filing_pressure: 1 } },
];

describe("tickAtCursor", () => {
  it("returns the tick of the last clock.sync at or before the cursor", () => {
    const timeline = timelineWithTicks([0, 1, 2]);
    assert.equal(tickAtCursor(timeline, 0), 0);
    assert.equal(tickAtCursor(timeline, 1), 1);
    assert.equal(tickAtCursor(timeline, 2), 2);
  });

  it("never reads a clock.sync past the cursor (rule 7: as-of-cursor invariant)", () => {
    const timeline = timelineWithTicks([0, 1, 2]);
    assert.equal(tickAtCursor(timeline, 1), 1);
  });

  it("returns undefined for a timeline with no clock.sync at all (graceful absence — office-sim-golden)", () => {
    const timeline: RunTimeline = { version: "simfile.run-timeline.v1", runId: "run-test", elements: [], events: [] };
    assert.equal(tickAtCursor(timeline, 5), undefined);
  });

  it("returns a recorded tick from a dynamics-only timeline", () => {
    const queued = clockSync(3, 0);
    queued.type = "dynamics.action.queued";
    queued.payload = {
      attempt: { act_id: "act:alpha", at_tick: 12 },
      receipt: { act_id: "act:alpha", apply_tick: 13 },
    };
    const timeline: RunTimeline = {
      version: "simfile.run-timeline.v1",
      runId: "run-dynamics",
      elements: [],
      events: [queued],
    };
    assert.equal(recordedTickOf(queued), 13);
    assert.equal(tickAtCursor(timeline, 3), 13);
  });

  it("ignores a later event whose type records no tick", () => {
    const applied = clockSync(2, 0);
    applied.type = "dynamics.action.applied";
    applied.payload = { act_id: "act:alpha", apply_tick: 7 };
    const unticked = clockSync(3, 99);
    unticked.type = "record.observed";
    const timeline: RunTimeline = {
      version: "simfile.run-timeline.v1",
      runId: "run-dynamics",
      elements: [],
      events: [applied, unticked],
    };
    assert.equal(recordedTickOf(unticked), undefined);
    assert.equal(tickAtCursor(timeline, 3), 7);
  });

  it("delegates both endpoint semantics to the corroborated record clock", () => {
    const firstTick = 0;
    const lastTick = 43;
    const events = [
      eventAtTick(0, firstTick, "dynamics.session.initial", {}),
      eventAtTick(1, firstTick + 1, "clock.sync", { tick: firstTick + 1 }),
      eventAtTick(2, lastTick - 1, "dynamics.step", { from_tick: lastTick - 1 }),
      eventAtTick(3, lastTick, "dynamics.session.final", {}),
    ];
    const timeline: RunTimeline = {
      version: "simfile.run-timeline.v1",
      runId: "run-endpoints",
      elements: [],
      events,
    };
    const cadence = derivePlaybackCadence({
      eventCount: events.length,
      events,
      firstTick,
      lastTick,
      tickDurationMs: 20,
      speed: 1,
    });

    assert.equal(recordedTickAtCursor(timeline, 0), undefined);
    assert.equal(tickAtCursor(timeline, 0, cadence), 0);
    assert.notEqual(
      tickAtCursor(timeline, 0, cadence),
      recordedTickAtCursor(timeline, 0),
    );
    for (const cursor of [1, 2]) {
      assert.equal(tickAtCursor(timeline, cursor, cadence), recordedTickAtCursor(timeline, cursor));
    }
    assert.equal(recordedTickAtCursor(timeline, 3), lastTick - 1);
    assert.equal(tickAtCursor(timeline, 3, cadence), lastTick);
    assert.notEqual(
      tickAtCursor(timeline, 3, cadence),
      recordedTickAtCursor(timeline, 3),
    );
  });

  it("rounds ledger millisecond truncation to the action feed's whole tick", () => {
    const lastTick = 1_000;
    const actionTick = 803;
    const events = Array.from({ length: lastTick + 1 }, (_, tick) =>
      eventAtTick(tick, tick, "clock.sync", { tick }));
    events[actionTick] = eventAtTick(actionTick, actionTick, "dynamics.action.applied", {
      accepted: true,
      act_id: "act:measured",
      action: "advance",
      actor: "principal:alpha",
      apply_tick: actionTick,
      principal_id: "principal:alpha",
      sequence: 1,
    });
    const timeline: RunTimeline = {
      version: "simfile.run-timeline.v1",
      runId: "run-millisecond-truncation",
      elements: [],
      events,
    };
    const cadence = derivePlaybackCadence({
      eventCount: events.length,
      events,
      firstTick: 0,
      lastTick,
      tickDurationMs: 20,
      speed: 1,
    });
    const rawDerivedTick = Date.parse(events[actionTick]!.recordedAt) / 20;
    const tick = tickAtCursor(timeline, actionTick, cadence);

    assert.equal(rawDerivedTick, actionTick - 0.05);
    assert.equal(tick, actionTick);
    assert.equal(Number.isInteger(tick), true);
    const rows = actionsAtTick(timeline, tick);
    assert.notEqual(rows.length, 0);
    assert.deepEqual(rows.map((row) => [row.actId, row.tick]), [["act:measured", actionTick]]);
  });

  it("keeps a record with no stated time undefined with or without cadence", () => {
    const events = [0, 1, 2].map((cursor) =>
      eventAtTick(cursor, cursor, "record.observed", { value: cursor }));
    const timeline: RunTimeline = {
      version: "simfile.run-timeline.v1",
      runId: "run-timeless",
      elements: [],
      events,
    };
    const cadence = derivePlaybackCadence({
      eventCount: events.length,
      events,
      speed: 1,
    });

    for (let cursor = 0; cursor < events.length; cursor += 1) {
      assert.equal(tickAtCursor(timeline, cursor), undefined);
      assert.equal(tickAtCursor(timeline, cursor, cadence), undefined);
    }
  });
});

describe("recordedTickOf", () => {
  it("reads each supported event's own tick field and does not derive one", () => {
    const step = clockSync(0, 0);
    step.type = "dynamics.step";
    step.payload = { from_tick: 5 };
    const ingress = clockSync(1, 0);
    ingress.type = "dynamics.action.rejected_at_ingress";
    ingress.payload = { attempt: { at_tick: 6 }, receipt: { apply_tick: "invalid" } };
    assert.equal(recordedTickOf(step), 5);
    assert.equal(recordedTickOf(ingress), 6);
  });
});

describe("sampleAtTick", () => {
  it("returns the last sample whose own tick is <= the given tick", () => {
    assert.equal(sampleAtTick(samplesFixture, 0)?.variables.filing_pressure, 0.7);
    assert.equal(sampleAtTick(samplesFixture, 1)?.variables.filing_pressure, 1);
  });

  it("is undefined when samples is undefined or tick is undefined (graceful absence)", () => {
    assert.equal(sampleAtTick(undefined, 0), undefined);
    assert.equal(sampleAtTick(samplesFixture, undefined), undefined);
  });
});

describe("trajectoryUpToTick", () => {
  it("returns the value series up to and including the given tick, never a future sample", () => {
    assert.deepEqual(trajectoryUpToTick(samplesFixture, "filing_pressure", 1), [0.7, 1]);
    assert.deepEqual(trajectoryUpToTick(samplesFixture, "filing_pressure", 2), [0.7, 1, 1]);
  });

  it("returns [] for an undefined tick or samples (graceful absence)", () => {
    assert.deepEqual(trajectoryUpToTick(undefined, "filing_pressure", 1), []);
    assert.deepEqual(trajectoryUpToTick(samplesFixture, "filing_pressure", undefined), []);
  });

  it("returns [] for a variable id absent from every sample", () => {
    assert.deepEqual(trajectoryUpToTick(samplesFixture, "no_such_variable", 2), []);
  });
});
