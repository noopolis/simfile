import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RunTimeline, TimelineEvent } from "../store/timeline.js";
import {
  defaultReplayPanel,
  hasMeaningfulConversation,
  initialReplayPanel,
} from "./replayPanel.js";

const event = (overrides: Partial<TimelineEvent>): TimelineEvent => ({
  actor: "analyst",
  authority: "moltnet",
  causes: [],
  eventId: "message-1",
  payload: {},
  recordedAt: "2026-08-16T12:00:00.000Z",
  seq: 1,
  streamId: "room:dream_lab:consulting-room",
  subjects: ["room:dream_lab:consulting-room"],
  t: 1,
  text: "A dream is spoken.",
  type: "message.accepted",
  viewClass: "message",
  ...overrides,
});

const timeline = (events: TimelineEvent[]): RunTimeline => ({
  elements: [
    { kind: "agent", label: "Analyst", ref: "agent:analyst" },
    { kind: "room", label: "Consulting room", ref: "room:dream_lab:consulting-room" },
  ],
  events,
  runId: "jungian-dialogue",
  version: "simfile.run-timeline.v1",
});

describe("replay panel selection", () => {
  it("finds participant speech anywhere in the complete timeline", () => {
    const run = timeline([
      event({ actor: undefined, eventId: "clock", t: 0, text: undefined, viewClass: "clock" }),
      event({ eventId: "later-speech", t: 1 }),
    ]);
    assert.equal(hasMeaningfulConversation(run), true);
    assert.equal(defaultReplayPanel(run), "conversation");
  });

  it("falls back to map for world/control, undeclared, or blank messages", () => {
    for (const candidate of [
      event({ actor: "world" }),
      event({ actor: "undeclared" }),
      event({ text: "   " }),
      event({ viewClass: "wake" }),
    ]) {
      assert.equal(defaultReplayPanel(timeline([candidate])), "map");
    }
  });

  it("prefers an explicit panel, then an existing user selection", () => {
    const withSpeech = timeline([event({})]);
    const withoutSpeech = timeline([]);
    assert.equal(initialReplayPanel(withSpeech, "map", null), "map");
    assert.equal(initialReplayPanel(withoutSpeech, "conversation", null), "conversation");
    assert.equal(initialReplayPanel(withSpeech, undefined, "map"), "map");
  });
});
