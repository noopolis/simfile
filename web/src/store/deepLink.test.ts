import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import { applyDeepLink, currentDeepLink, parseDeepLink, serializeDeepLink } from "./deepLink.js";
import {
  loadTimeline,
  resetTimelineStoreForTests,
  setCursor,
  setOpenPortals,
  setSelection,
  timelineStore,
  type RunTimeline,
} from "./timeline.js";

const fixtureTimeline = (): RunTimeline => ({
  version: "simfile.run-timeline.v1",
  runId: "run-test",
  events: Array.from({ length: 4 }, (_, t) => ({
    t,
    eventId: `event-${t}`,
    authority: "moltnet",
    streamId: "room:net:room",
    seq: t,
    type: "message.accepted",
    viewClass: "message" as const,
    recordedAt: new Date(2026, 0, 1, 0, 0, t).toISOString(),
    subjects: ["room:net:room"],
    causes: t > 0 ? [`event-${t - 1}`] : [],
    text: `text-${t}`,
    payload: {},
  })),
  elements: [{ ref: "room:net:room", kind: "room", label: "room" }],
});

describe("deepLink", () => {
  beforeEach(() => {
    resetTimelineStoreForTests();
  });

  it("parses at/sel/portals from a query string, with or without the leading '?'", () => {
    const parsed = parseDeepLink("?at=event-2&sel=agent:eleanor&portals=room:net:room,bank:office-recall");
    assert.deepEqual(parsed, { at: "event-2", sel: "agent:eleanor", portals: ["room:net:room", "bank:office-recall"] });

    const withoutLeadingMark = parseDeepLink("at=event-2&sel=agent:eleanor");
    assert.equal(withoutLeadingMark.at, "event-2");
    assert.equal(withoutLeadingMark.sel, "agent:eleanor");
    assert.deepEqual(withoutLeadingMark.portals, []);
  });

  it("parses an empty search string to all-empty params", () => {
    const parsed = parseDeepLink("");
    assert.deepEqual(parsed, { at: undefined, sel: undefined, portals: [] });
  });

  it("serializeDeepLink omits absent fields and joins portals with commas", () => {
    assert.equal(serializeDeepLink({ at: undefined, sel: undefined, portals: [] }), "");
    assert.equal(
      serializeDeepLink({ at: "event-2", sel: "agent:eleanor", portals: ["room:net:room", "bank:x"] }),
      "?at=event-2&sel=agent%3Aeleanor&portals=room%3Anet%3Aroom%2Cbank%3Ax",
    );
  });

  it("round-trips serialize -> parse to the same params", () => {
    const original = { at: "event-3", sel: "bank:office-recall", portals: ["agent:eleanor", "room:net:room"] };
    const roundTripped = parseDeepLink(serializeDeepLink(original));
    assert.deepEqual(roundTripped, original);
  });

  it("currentDeepLink reads the store's cursor as the event id at that cursor, not the raw index", () => {
    loadTimeline(fixtureTimeline());
    setCursor(2);
    setSelection("room:net:room");
    setOpenPortals(["room:net:room"]);

    const current = currentDeepLink(timelineStore.getSnapshot());
    assert.equal(current.at, "event-2");
    assert.equal(current.sel, "room:net:room");
    assert.deepEqual(current.portals, ["room:net:room"]);
  });

  it("applyDeepLink resolves 'at' to the resolved event's current t, and restores selection/portals", () => {
    loadTimeline(fixtureTimeline());
    applyDeepLink(fixtureTimeline(), { at: "event-3", sel: "room:net:room", portals: ["room:net:room"] });

    const state = timelineStore.getSnapshot();
    assert.equal(state.cursor, 3);
    assert.equal(state.selection, "room:net:room");
    assert.deepEqual(state.openPortals, ["room:net:room"]);
  });

  it("applyDeepLink ignores an 'at' event id that isn't in the timeline rather than throwing", () => {
    loadTimeline(fixtureTimeline());
    applyDeepLink(fixtureTimeline(), { at: "event-does-not-exist", sel: undefined, portals: [] });
    assert.equal(timelineStore.getSnapshot().cursor, 0);
  });

  it("full round trip: serialize the current store state, parse it back, apply it, and land on the same cursor/selection/portals", () => {
    const timeline = fixtureTimeline();
    loadTimeline(timeline);
    setCursor(1);
    setSelection("room:net:room");
    setOpenPortals(["room:net:room"]);

    const serialized = serializeDeepLink(currentDeepLink(timelineStore.getSnapshot()));

    resetTimelineStoreForTests();
    loadTimeline(timeline);
    applyDeepLink(timeline, parseDeepLink(serialized));

    const restored = timelineStore.getSnapshot();
    assert.equal(restored.cursor, 1);
    assert.equal(restored.selection, "room:net:room");
    assert.deepEqual(restored.openPortals, ["room:net:room"]);
  });
});
