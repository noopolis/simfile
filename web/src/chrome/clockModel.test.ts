import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { currentClockReadout, derivePhaseBands, spreadDotEvents } from "./clockModel.js";
import type { TimelineEvent } from "../store/timeline.js";

const clockEvent = (t: number, tick: number, phase: string): TimelineEvent => ({
  t,
  eventId: `clock-${t}`,
  authority: "world",
  streamId: "world",
  seq: t,
  type: "clock.sync",
  viewClass: "clock",
  recordedAt: "2026-07-12T00:00:00.000Z",
  subjects: ["clock:global"],
  causes: [],
  payload: { sim_time: tick * 60, tick, phase },
});

const messageEvent = (t: number, eventId: string): TimelineEvent => ({
  t,
  eventId,
  authority: "moltnet",
  streamId: "network:office_lab",
  seq: t,
  type: "message.accepted",
  viewClass: "message",
  recordedAt: "2026-07-12T00:00:00.000Z",
  subjects: ["room:office_lab:office-room"],
  causes: [],
  payload: {},
});

describe("derivePhaseBands", () => {
  it("returns [] for a run with no clock.sync stream (graceful absence)", () => {
    assert.deepEqual(derivePhaseBands([messageEvent(0, "m-0")]), []);
  });

  it("makes one band per tick, each running to just before the next tick's t", () => {
    const events = [clockEvent(0, 0, "workday"), messageEvent(1, "m-1"), clockEvent(2, 1, "workday")];
    const bands = derivePhaseBands(events);
    assert.deepEqual(bands, [
      { t0: 0, t1: 1, tick: 0, phase: "workday" },
      { t0: 2, t1: Number.MAX_SAFE_INTEGER, tick: 1, phase: "workday" },
    ]);
  });

  it("carries a phase change into its own band", () => {
    const events = [clockEvent(0, 0, "morning"), clockEvent(1, 1, "workday")];
    const bands = derivePhaseBands(events);
    assert.deepEqual(bands.map((band) => band.phase), ["morning", "workday"]);
  });
});

describe("currentClockReadout", () => {
  it("is undefined before the first tick, and for a run with no clock stream", () => {
    assert.equal(currentClockReadout([], 0), undefined);
    assert.equal(currentClockReadout([clockEvent(2, 1, "workday")], 0), undefined);
  });

  it("returns the latest tick at or before the cursor", () => {
    const events = [clockEvent(0, 0, "workday"), clockEvent(3, 1, "workday"), clockEvent(6, 2, "evening")];
    assert.deepEqual(currentClockReadout(events, 4), { tick: 1, phase: "workday", simTime: 60 });
    assert.deepEqual(currentClockReadout(events, 6), { tick: 2, phase: "evening", simTime: 120 });
  });
});

describe("spreadDotEvents", () => {
  it("returns only the events whose id is in the seed-spread set", () => {
    const events = [messageEvent(0, "moltnet:a"), messageEvent(1, "moltnet:b"), messageEvent(2, "moltnet:c")];
    const dots = spreadDotEvents(events, new Set(["moltnet:b"]));
    assert.deepEqual(dots.map((event) => event.eventId), ["moltnet:b"]);
  });

  it("returns [] when no seed-spread id joins to a real event in this run", () => {
    const events = [messageEvent(0, "moltnet:a")];
    assert.deepEqual(spreadDotEvents(events, new Set(["doc-seed:eleanor:epoch"])), []);
  });
});
