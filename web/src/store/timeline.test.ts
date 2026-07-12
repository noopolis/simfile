import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import {
  agentsForMembrane,
  banksForMembrane,
  breadcrumbSegments,
  closePortal,
  clearHighlightedEventIds,
  echoedWorldEventIds,
  eventsForElement,
  eventsForMembrane,
  eventsUpTo,
  focusAndOpenPortal,
  jumpEnd,
  jumpStart,
  loadTimeline,
  maxCursor,
  membraneForRef,
  membraneForRepresentative,
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
  type TimelineEvent,
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
  membranes: [],
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
  membranes: [],
});

/**
 * A scaled-down jungian-shaped fixture: an outer `commons` room with a
 * representative, an interior `luna-council` room with the representative
 * plus animus/shadow, a decoy `selene-council` bank with NO overlapping
 * event (so `banksForMembrane` must not pick it up by name alone), and one
 * `team:luna` membrane.
 */
const fixtureTimelineWithMembrane = (): RunTimeline => ({
  version: "simfile.run-timeline.v1",
  runId: "run-membrane-test",
  events: [
    {
      t: 0, eventId: "floor-1", authority: "moltnet", streamId: "room:psyche-floor:commons", seq: 0,
      type: "message.accepted", viewClass: "message", recordedAt: "2026-01-01T00:00:00.000Z",
      actor: "luna-representative", subjects: ["room:psyche-floor:commons", "agent:luna-representative"],
      causes: [], text: "Consulting my inner council.", payload: {},
    },
    {
      t: 1, eventId: "council-1", authority: "moltnet", streamId: "room:luna_inner:luna-council", seq: 0,
      type: "message.accepted", viewClass: "message", recordedAt: "2026-01-01T00:00:01.000Z",
      actor: "luna-animus", subjects: ["room:luna_inner:luna-council", "agent:luna-animus"],
      causes: ["floor-1"], text: "As the animus: I see momentum.", payload: {},
    },
    {
      t: 2, eventId: "council-2", authority: "moltnet", streamId: "room:luna_inner:luna-council", seq: 1,
      type: "message.accepted", viewClass: "message", recordedAt: "2026-01-01T00:00:02.000Z",
      actor: "luna-shadow", subjects: ["room:luna_inner:luna-council", "agent:luna-shadow"],
      causes: ["council-1"], text: "As the shadow: COUNCIL-CONCLUDED.", payload: {},
    },
    {
      t: 3, eventId: "council-recall", authority: "mneme", streamId: "bank:luna-council", seq: 0,
      type: "memory.recalled", viewClass: "memory.recalled", recordedAt: "2026-01-01T00:00:03.000Z",
      subjects: ["bank:luna-council", "agent:luna-shadow"], causes: [], text: "recalled prior counsel", payload: {},
    },
    {
      t: 4, eventId: "floor-2", authority: "moltnet", streamId: "room:psyche-floor:commons", seq: 1,
      type: "message.accepted", viewClass: "message", recordedAt: "2026-01-01T00:00:04.000Z",
      actor: "luna-representative", subjects: ["room:psyche-floor:commons", "agent:luna-representative"],
      causes: ["council-2"], text: "The council has spoken.", payload: {},
    },
    {
      t: 5, eventId: "decoy-1", authority: "mneme", streamId: "bank:selene-council", seq: 0,
      type: "memory.recalled", viewClass: "memory.recalled", recordedAt: "2026-01-01T00:00:05.000Z",
      subjects: ["bank:selene-council", "agent:selene-shadow"], causes: [], text: "unrelated selene memory", payload: {},
    },
  ],
  elements: [
    { ref: "room:psyche-floor:commons", kind: "room", label: "commons" },
    { ref: "room:luna_inner:luna-council", kind: "room", label: "luna-council" },
    { ref: "agent:luna-representative", kind: "agent", label: "luna-representative" },
    { ref: "agent:luna-animus", kind: "agent", label: "luna-animus" },
    { ref: "agent:luna-shadow", kind: "agent", label: "luna-shadow" },
    { ref: "agent:selene-shadow", kind: "agent", label: "selene-shadow" },
    { ref: "bank:luna-council", kind: "bank", label: "luna-council" },
    { ref: "bank:selene-council", kind: "bank", label: "selene-council" },
    { ref: "team:luna", kind: "team", label: "luna" },
  ],
  membranes: [{
    ref: "team:luna",
    label: "luna",
    representative: "agent:luna-representative",
    interiorRooms: ["room:luna_inner:luna-council"],
    members: ["agent:luna-animus", "agent:luna-representative", "agent:luna-shadow"],
  }],
});

describe("membrane selectors (recursive membrane portal)", () => {
  it("membraneForRef finds a membrane by its own ref, undefined for a leaf agent/room", () => {
    const timeline = fixtureTimelineWithMembrane();
    assert.equal(membraneForRef(timeline, "team:luna")?.label, "luna");
    assert.equal(membraneForRef(timeline, "agent:luna-animus"), undefined);
    assert.equal(membraneForRef(timeline, "room:luna_inner:luna-council"), undefined);
  });

  it("membraneForRef returns undefined for every element in a leaf-only run (office-sim regression)", () => {
    const timeline = fixtureTimeline();
    for (const element of timeline.elements) {
      assert.equal(membraneForRef(timeline, element.ref), undefined);
    }
  });

  it("membraneForRepresentative resolves the representative agent to its membrane, and only that agent", () => {
    const timeline = fixtureTimelineWithMembrane();
    assert.equal(membraneForRepresentative(timeline, "agent:luna-representative")?.ref, "team:luna");
    assert.equal(membraneForRepresentative(timeline, "agent:luna-animus"), undefined);
    assert.equal(membraneForRepresentative(timeline, "agent:luna-shadow"), undefined);
  });

  it("banksForMembrane picks the bank by overlapping events, not by name — the decoy selene bank is excluded", () => {
    const timeline = fixtureTimelineWithMembrane();
    const banks = banksForMembrane(timeline, "team:luna");
    assert.deepEqual(banks.map((bank) => bank.ref), ["bank:luna-council"]);
  });

  it("banksForMembrane is empty for a ref with no membrane", () => {
    const timeline = fixtureTimelineWithMembrane();
    assert.deepEqual(banksForMembrane(timeline, "agent:luna-animus"), []);
  });

  it("agentsForMembrane returns exactly the membrane's own member agents", () => {
    const timeline = fixtureTimelineWithMembrane();
    const agents = agentsForMembrane(timeline, "team:luna").map((agent) => agent.ref).sort();
    assert.deepEqual(agents, ["agent:luna-animus", "agent:luna-representative", "agent:luna-shadow"]);
  });

  it("breadcrumbSegments for a leaf portal is unchanged from before membranes existed", () => {
    const timeline = fixtureTimeline();
    assert.deepEqual(breadcrumbSegments(timeline, [], "agent:eleanor"), ["world", "eleanor"]);
    assert.deepEqual(breadcrumbSegments(timeline, [], "room:net:room"), ["world", "net:room"]);
  });

  it("breadcrumbSegments for a membrane portal shows the team + its own council room", () => {
    const timeline = fixtureTimelineWithMembrane();
    assert.deepEqual(breadcrumbSegments(timeline, ["team:luna"], "team:luna"), ["world", "luna", "luna-council"]);
  });

  it("breadcrumbSegments for a descendant opened from an open membrane portal nests under it (recursion)", () => {
    const timeline = fixtureTimelineWithMembrane();
    assert.deepEqual(
      breadcrumbSegments(timeline, ["team:luna", "agent:luna-shadow"], "agent:luna-shadow"),
      ["world", "luna", "luna-council", "luna-shadow"],
    );
  });

  it("breadcrumbSegments does not nest a descendant whose membrane isn't actually open yet", () => {
    const timeline = fixtureTimelineWithMembrane();
    assert.deepEqual(breadcrumbSegments(timeline, ["agent:luna-shadow"], "agent:luna-shadow"), ["world", "luna-shadow"]);
  });
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

  it("eventsForMembrane unions interior-room and member storylines, deduplicated by eventId in t order", () => {
    const timeline = fixtureTimeline();
    timeline.events[2] = {
      ...timeline.events[2]!,
      subjects: ["room:net:room", "agent:eleanor"],
    };
    timeline.membranes = [{
      ref: "team:research",
      label: "Research",
      representative: "agent:eleanor",
      interiorRooms: ["room:net:room"],
      members: ["agent:eleanor"],
    }];

    const events = eventsForMembrane(timeline, "team:research");
    assert.deepEqual(events.map((event) => event.eventId), [
      "event-0",
      "event-1",
      "event-2",
      "event-3",
      "event-4",
    ]);
    assert.equal(events.filter((event) => event.eventId === "event-2").length, 1);
    assert.deepEqual(events.map((event) => event.t), [0, 1, 2, 3, 4]);
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

describe("echoedWorldEventIds (increment 3 world/moltnet dedup)", () => {
  const baseEvent: TimelineEvent = {
    t: 0,
    eventId: "world:seed",
    authority: "world",
    streamId: "world",
    seq: 1,
    type: "world.message",
    viewClass: "message",
    recordedAt: "2026-07-12T00:00:00.000Z",
    subjects: ["room:net:room"],
    causes: [],
    text: "seed text",
    payload: {},
  };

  it("collects a world event id that a moltnet message's worldEventId names as its echo", () => {
    const echo: TimelineEvent = {
      ...baseEvent,
      t: 1,
      eventId: "moltnet:world:seed",
      authority: "moltnet",
      worldEventId: "world:seed",
    };
    const echoed = echoedWorldEventIds([baseEvent, echo]);
    assert.ok(echoed.has("world:seed"));
    assert.equal(echoed.size, 1);
  });

  it("does not flag a world event with no moltnet echo", () => {
    const genuineReply: TimelineEvent = {
      ...baseEvent,
      t: 1,
      eventId: "moltnet:reply",
      authority: "moltnet",
      worldEventId: undefined,
    };
    const echoed = echoedWorldEventIds([baseEvent, genuineReply]);
    assert.equal(echoed.has("world:seed"), false);
    assert.equal(echoed.size, 0);
  });
});
