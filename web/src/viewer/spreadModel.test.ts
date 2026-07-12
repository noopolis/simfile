import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { firstAppearanceGlowScopes, seedSpreadEventIds, utteredEventIds, type SeedSpreadEntry, type SpreadSummary } from "./spreadModel.js";
import type { RunTimeline, TimelineEvent } from "../store/timeline.js";

const baseEvent = (overrides: Partial<TimelineEvent>): TimelineEvent => ({
  t: 0,
  eventId: "event-0",
  authority: "moltnet",
  streamId: "network:office_lab",
  seq: 1,
  type: "message.accepted",
  viewClass: "message",
  recordedAt: "2026-07-12T00:00:00.000Z",
  subjects: ["room:office_lab:office-room"],
  causes: [],
  payload: {},
  ...overrides,
});

const seedSpreadFixture: SeedSpreadEntry[] = [
  { channel: "doc-seeded", event_id: "doc-seed:eleanor:epoch", agent: "eleanor", fidelity: 1 },
  { channel: "uttered", event_id: "moltnet:msg-eleanor", agent: "eleanor", tick: 1, fidelity: 1 },
  { channel: "uttered", event_id: "moltnet:msg-sam", agent: "sam", tick: 1, fidelity: 1 },
  { channel: "registered", event_id: "evt-1", agent: "eleanor", fidelity: 1 },
];

describe("seedSpreadEventIds", () => {
  it("collects every entry's event_id regardless of channel", () => {
    const ids = seedSpreadEventIds(seedSpreadFixture);
    assert.deepEqual(
      [...ids].sort(),
      ["doc-seed:eleanor:epoch", "evt-1", "moltnet:msg-eleanor", "moltnet:msg-sam"].sort(),
    );
  });

  it("is empty for an undefined seedSpread (graceful absence)", () => {
    assert.equal(seedSpreadEventIds(undefined).size, 0);
  });
});

describe("utteredEventIds", () => {
  it("keeps only the uttered channel's event ids", () => {
    const ids = utteredEventIds(seedSpreadFixture);
    assert.deepEqual([...ids].sort(), ["moltnet:msg-eleanor", "moltnet:msg-sam"]);
  });

  it("is empty for an undefined seedSpread", () => {
    assert.equal(utteredEventIds(undefined).size, 0);
  });
});

describe("firstAppearanceGlowScopes", () => {
  const timeline: RunTimeline = {
    version: "simfile.run-timeline.v1",
    runId: "run-test",
    elements: [],
    membranes: [],
    events: [
      baseEvent({ t: 0, eventId: "moltnet:msg-eleanor", actor: "eleanor" }),
      baseEvent({ t: 1, eventId: "moltnet:msg-sam", actor: "sam" }),
    ],
  };

  const spreadSummary: SpreadSummary = {
    reach: 1,
    latency: 1,
    first_appearance: [{ agent: "sam", channel: "uttered", event_id: "moltnet:msg-sam", tick: 1 }],
  };

  it("returns no glow scopes before the cursor reaches the first-appearance event", () => {
    assert.deepEqual(firstAppearanceGlowScopes({ spreadSummary, timeline, cursor: 0 }), []);
  });

  it("glows the agent (and room, when given) once the cursor reaches the first-appearance event", () => {
    const scopes = firstAppearanceGlowScopes({
      spreadSummary,
      timeline,
      cursor: 1,
      roomScope: "room:office_lab:office-room",
    });
    assert.deepEqual(scopes.sort(), ["agent:sam", "room:office_lab:office-room"]);
  });

  it("returns [] when there is no spreadSummary at all (graceful absence)", () => {
    assert.deepEqual(firstAppearanceGlowScopes({ spreadSummary: undefined, timeline, cursor: 5 }), []);
  });

  it("ignores a first-appearance event_id that isn't in this timeline", () => {
    const danglingSummary: SpreadSummary = {
      reach: 1,
      first_appearance: [{ agent: "ghost", channel: "uttered", event_id: "moltnet:not-in-run" }],
    };
    assert.deepEqual(firstAppearanceGlowScopes({ spreadSummary: danglingSummary, timeline, cursor: 10 }), []);
  });
});
