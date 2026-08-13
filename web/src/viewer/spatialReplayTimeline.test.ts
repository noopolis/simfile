import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cursorAtElapsed,
  derivePlaybackCadence,
  playbackTickAtCursor,
} from "../chrome/playbackCadence.js";
import { maxCursor, type RunTimeline } from "../store/timeline.js";
import { recordedTickAtCursor } from "./variableModel.js";
import { sealedReplayTimeline } from "./spatialReplayTimeline.js";
import type { ViewerSpatialSample } from "./types.js";

const timeline = (events: RunTimeline["events"] = []): RunTimeline => ({
  elements: [],
  events,
  runId: "spatial-only",
  version: "simfile.run-timeline.v1",
});

const samples: ViewerSpatialSample[] = [0, 5, 12].map((tick) => ({
  objects: [{ id: "object-a", position: [tick, 0], velocity: [0, 0] }],
  occupancy: {},
  tick,
  transit: [],
}));

describe("sealed spatial replay timeline", () => {
  it("uses spatial-sample rows as the one cursor axis when causal events are absent", () => {
    const replay = sealedReplayTimeline(timeline(), samples);
    assert.equal(replay.runId, "spatial-only");
    assert.equal(replay.events.length, samples.length);
    assert.equal(maxCursor(replay), 2);
    assert.deepEqual(replay.events.map(({ type, payload }) => ({ type, payload })), [
      { type: "spatial.sample", payload: { tick: 0 } },
      { type: "spatial.sample", payload: { tick: 5 } },
      { type: "spatial.sample", payload: { tick: 12 } },
    ]);
    assert.equal(recordedTickAtCursor(replay, 0), 0);
    assert.equal(recordedTickAtCursor(replay, 2), 12);

    const cadence = derivePlaybackCadence({ eventCount: replay.events.length,
      events: replay.events, firstTick: 0, lastTick: 12,
      speed: 1, tickDurationMs: 20 });
    assert.equal(playbackTickAtCursor(cadence, 1), 5);
    assert.equal(cursorAtElapsed(0, 99, cadence, maxCursor(replay)), 0);
    assert.equal(cursorAtElapsed(0, 100, cadence, maxCursor(replay)), 1);
    assert.equal(cursorAtElapsed(0, cadence.realDurationMs, cadence, maxCursor(replay)), 2);
  });

  it("never replaces a real causal axis or fabricates an empty sample axis", () => {
    const causal = timeline([{
      authority: "world", causes: [], eventId: "world:1", payload: {},
      recordedAt: "2026-08-10T00:00:00.000Z", seq: 1, streamId: "world",
      subjects: [], t: 0, type: "world.message", viewClass: "message",
    }]);
    assert.equal(sealedReplayTimeline(causal, samples), causal);
    const empty = timeline();
    assert.equal(sealedReplayTimeline(empty, []), empty);
  });
});
