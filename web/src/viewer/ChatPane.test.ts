import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RunTimeline, TimelineEvent } from "../store/timeline.js";
import { participantChatMessages } from "./ChatPane.js";

const message = (actor: string, eventId: string, t: number, text = eventId): TimelineEvent => ({
  actor,
  authority: "moltnet",
  causes: [],
  eventId,
  payload: {},
  recordedAt: "2026-08-05T09:03:18.000Z",
  seq: t,
  streamId: "room",
  subjects: ["room:shared"],
  t,
  text,
  type: "message.accepted",
  viewClass: "message",
});

describe("participantChatMessages", () => {
  it("keeps participant speech and excludes control-plane messages", () => {
    const timeline: RunTimeline = {
      elements: [{ kind: "agent", label: "Alpha", ref: "agent:alpha" }],
      events: [message("world", "opaque-control", 0), message("alpha", "visible-reply", 1)],
      runId: "run",
      version: "simfile.run-timeline.v1",
    };

    assert.deepEqual(
      participantChatMessages(timeline, 1).map(({ eventId }) => eventId),
      ["visible-reply"],
    );
  });

  it("excludes undeclared and blank participant-like messages", () => {
    const timeline: RunTimeline = {
      elements: [{ kind: "agent", label: "Alpha", ref: "agent:alpha" }],
      events: [message("unknown", "undeclared", 0), message("alpha", "blank", 1, "  ")],
      runId: "run",
      version: "simfile.run-timeline.v1",
    };

    assert.deepEqual(participantChatMessages(timeline, 1), []);
  });
});
