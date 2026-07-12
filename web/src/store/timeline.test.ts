import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import {
  closePortal,
  clearHighlightedEventIds,
  eventsForElement,
  eventsUpTo,
  focusAndOpenPortal,
  jumpEnd,
  jumpStart,
  loadTimeline,
  maxCursor,
  openPortal,
  pause,
  play,
  recallEventsForTurnInput,
  resetTimelineStoreForTests,
  setCursor,
  setHighlightedEventIds,
  setOpenPortals,
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

/** A timeline shaped like the golden fixture's turn 3: a turn.input caused by its message plus two mneme: recalls. */
const fixtureTimelineWithRecall = (): RunTimeline => ({
  version: "simfile.run-timeline.v1",
  runId: "run-recall-test",
  events: [
    {
      t: 0, eventId: "moltnet:msg-1", authority: "moltnet", streamId: "room:net:room", seq: 0,
      type: "message.accepted", viewClass: "message", recordedAt: "2026-01-01T00:00:00.000Z",
      subjects: ["room:net:room", "agent:eleanor"], causes: [], text: "hello", payload: {},
    },
    {
      t: 1, eventId: "mneme:recall-a", authority: "mneme", streamId: "bank:office-recall", seq: 0,
      type: "memory.recalled", viewClass: "memory.recalled", recordedAt: "2026-01-01T00:00:01.000Z",
      subjects: ["bank:office-recall", "agent:sam"], causes: ["moltnet:msg-1"], text: "recalled memory A", payload: {},
    },
    {
      t: 2, eventId: "mneme:recall-b", authority: "mneme", streamId: "bank:office-recall", seq: 1,
      type: "memory.recalled", viewClass: "memory.recalled", recordedAt: "2026-01-01T00:00:02.000Z",
      subjects: ["bank:office-recall", "agent:sam"], causes: ["moltnet:msg-1"], text: "recalled memory B", payload: {},
    },
    {
      t: 3, eventId: "daimon:turn-3-input", authority: "daimon", streamId: "agent:sam", seq: 0,
      type: "turn.input.submitted", viewClass: "turn.input", recordedAt: "2026-01-01T00:00:03.000Z",
      subjects: ["agent:sam", "room:net:room"],
      causes: ["moltnet:msg-1", "mneme:recall-a", "mneme:recall-b"],
      payload: {},
    },
  ],
  elements: [
    { ref: "agent:eleanor", kind: "agent", label: "eleanor" },
    { ref: "agent:sam", kind: "agent", label: "sam" },
    { ref: "bank:office-recall", kind: "bank", label: "office-recall" },
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

  it("eventsForElement slices a bank storyline exactly like a room or agent one — one mechanism, all kinds", () => {
    const timeline = fixtureTimelineWithRecall();
    const bank = eventsForElement(timeline, "bank:office-recall");
    assert.deepEqual(bank.map((event) => event.eventId), ["mneme:recall-a", "mneme:recall-b"]);
    const room = eventsForElement(timeline, "room:net:room");
    assert.deepEqual(room.map((event) => event.eventId), ["moltnet:msg-1", "daimon:turn-3-input"]);
  });

  it("openPortal/closePortal/setOpenPortals manage the portal stack without disturbing other portals", () => {
    openPortal("agent:eleanor");
    openPortal("bank:office-recall");
    openPortal("agent:eleanor"); // idempotent
    assert.deepEqual(timelineStore.getSnapshot().openPortals, ["agent:eleanor", "bank:office-recall"]);
    closePortal("agent:eleanor");
    assert.deepEqual(timelineStore.getSnapshot().openPortals, ["bank:office-recall"]);
    setOpenPortals(["room:net:room", "room:net:room", "agent:sam"]);
    assert.deepEqual(timelineStore.getSnapshot().openPortals, ["room:net:room", "agent:sam"]);
  });

  it("focusAndOpenPortal sets selection and opens the portal in one call, for any element kind", () => {
    focusAndOpenPortal("room:net:room");
    assert.equal(timelineStore.getSnapshot().selection, "room:net:room");
    assert.ok(timelineStore.getSnapshot().openPortals.includes("room:net:room"));
  });

  it("setHighlightedEventIds/clearHighlightedEventIds track the recall-linked highlight set", () => {
    assert.deepEqual(timelineStore.getSnapshot().highlightedEventIds, []);
    setHighlightedEventIds(["mneme:recall-a"]);
    assert.deepEqual(timelineStore.getSnapshot().highlightedEventIds, ["mneme:recall-a"]);
    clearHighlightedEventIds();
    assert.deepEqual(timelineStore.getSnapshot().highlightedEventIds, []);
  });

  it("recallEventsForTurnInput resolves a turn.input's mneme: causes to the real memory.recalled rows, by id", () => {
    const timeline = fixtureTimelineWithRecall();
    const turnInput = timeline.events.find((event) => event.eventId === "daimon:turn-3-input")!;
    const recalls = recallEventsForTurnInput(timeline, turnInput);
    assert.deepEqual(recalls.map((event) => event.eventId), ["mneme:recall-a", "mneme:recall-b"]);
    assert.ok(recalls.every((event) => event.viewClass === "memory.recalled"));
  });

  it("recallEventsForTurnInput drops mneme: causes that don't resolve to a recorded event", () => {
    const timeline = fixtureTimelineWithRecall();
    const turnInput = timeline.events.find((event) => event.eventId === "daimon:turn-3-input")!;
    const withDangling = { ...turnInput, causes: [...turnInput.causes, "mneme:not-in-this-run"] };
    const recalls = recallEventsForTurnInput(timeline, withDangling);
    assert.deepEqual(recalls.map((event) => event.eventId), ["mneme:recall-a", "mneme:recall-b"]);
  });
});
