import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sampleAtTick, tickAtCursor, trajectoryUpToTick, type RunMetaVariableSample } from "./variableModel.js";
import type { RunTimeline, TimelineEvent } from "../store/timeline.js";

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
