import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import {
  eventsForElement,
  eventsUpTo,
  jumpEnd,
  jumpStart,
  loadTimeline,
  maxCursor,
  pause,
  play,
  resetTimelineStoreForTests,
  setCursor,
  setSelection,
  setSpeed,
  stepBy,
  timelineStore,
  togglePlay,
  type RunTimeline,
} from "./timeline.js";

const fixtureTimeline = (): RunTimeline => ({
  version: "simfile.run-timeline.v1",
  runId: "run-test",
  events: Array.from({ length: 5 }, (_, t) => ({
    t,
    eventId: `event-${t}`,
    authority: t % 2 === 0 ? "moltnet" : "daimon",
    streamId: "stream",
    seq: t,
    type: "message.accepted",
    viewClass: "message" as const,
    recordedAt: new Date(2026, 0, 1, 0, 0, t).toISOString(),
    subjects: t % 2 === 0 ? ["room:net:room"] : ["agent:eleanor"],
    causes: t > 0 ? [`event-${t - 1}`] : [],
    text: `text-${t}`,
    payload: {},
  })),
  elements: [
    { ref: "agent:eleanor", kind: "agent", label: "eleanor" },
    { ref: "room:net:room", kind: "room", label: "room" },
  ],
});

describe("timelineStore", () => {
  beforeEach(() => {
    resetTimelineStoreForTests();
  });

  it("loads a timeline and resets the cursor to 0", () => {
    loadTimeline(fixtureTimeline());
    assert.equal(timelineStore.getSnapshot().cursor, 0);
    assert.equal(timelineStore.getSnapshot().timeline?.events.length, 5);
  });

  it("clamps setCursor to [0, maxCursor]", () => {
    loadTimeline(fixtureTimeline());
    setCursor(-5);
    assert.equal(timelineStore.getSnapshot().cursor, 0);
    setCursor(999);
    assert.equal(timelineStore.getSnapshot().cursor, 4);
    setCursor(2);
    assert.equal(timelineStore.getSnapshot().cursor, 2);
  });

  it("steps and jumps relative to the current cursor", () => {
    loadTimeline(fixtureTimeline());
    setCursor(2);
    stepBy(1);
    assert.equal(timelineStore.getSnapshot().cursor, 3);
    stepBy(-2);
    assert.equal(timelineStore.getSnapshot().cursor, 1);
    jumpEnd();
    assert.equal(timelineStore.getSnapshot().cursor, 4);
    jumpStart();
    assert.equal(timelineStore.getSnapshot().cursor, 0);
  });

  it("toggles playback and enforces a speed floor", () => {
    assert.equal(timelineStore.getSnapshot().playing, false);
    play();
    assert.equal(timelineStore.getSnapshot().playing, true);
    pause();
    assert.equal(timelineStore.getSnapshot().playing, false);
    togglePlay();
    assert.equal(timelineStore.getSnapshot().playing, true);
    setSpeed(-10);
    assert.ok(timelineStore.getSnapshot().speed > 0);
  });

  it("tracks the current selection", () => {
    setSelection("agent:eleanor");
    assert.equal(timelineStore.getSnapshot().selection, "agent:eleanor");
    setSelection(null);
    assert.equal(timelineStore.getSnapshot().selection, null);
  });

  it("maxCursor is 0 for a null timeline and events.length-1 otherwise", () => {
    assert.equal(maxCursor(null), 0);
    assert.equal(maxCursor(fixtureTimeline()), 4);
  });

  it("eventsUpTo never returns an event with t greater than the cursor (the time-link invariant)", () => {
    const timeline = fixtureTimeline();
    for (let cursor = 0; cursor <= 4; cursor += 1) {
      const slice = eventsUpTo(timeline, cursor);
      assert.ok(slice.every((event) => event.t <= cursor));
      assert.equal(slice.length, cursor + 1);
    }
  });

  it("eventsForElement filters by subject ref, preserving t order", () => {
    const timeline = fixtureTimeline();
    const eleanor = eventsForElement(timeline, "agent:eleanor");
    assert.deepEqual(eleanor.map((event) => event.t), [1, 3]);
    const room = eventsForElement(timeline, "room:net:room");
    assert.deepEqual(room.map((event) => event.t), [0, 2, 4]);
  });
});
