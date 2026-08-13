import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cursorAtElapsed,
  derivePlaybackCadence,
  playbackCadenceReadout,
  playbackTickAtCursor,
  playbackTickAtElapsed,
  type PlaybackCadence,
  type PlaybackCadenceInput,
} from "./playbackCadence.js";

const measuredRunInput = (speed: number): PlaybackCadenceInput => ({
  eventCount: 202,
  firstTick: 0,
  lastTick: 200,
  tickDurationMs: 20,
  speed,
});

const frameWalk = (cadence: PlaybackCadence, durationMs: number, maxCursor = 201): number[] => {
  const originMs = 12_345.678;
  const cursors: number[] = [];
  for (let timestampMs = originMs; timestampMs <= originMs + durationMs; timestampMs += 16.6667) {
    cursors.push(cursorAtElapsed(0, timestampMs - originMs, cadence, maxCursor));
  }
  cursors.push(cursorAtElapsed(0, durationMs, cadence, maxCursor));
  return cursors;
};

const assertMonotone = (values: readonly number[]): void => {
  for (let index = 1; index < values.length; index += 1) {
    assert.ok(values[index]! >= values[index - 1]!);
  }
};

describe("derivePlaybackCadence", () => {
  /**
   * B146 acceptance numbers come from the measured served 200-tick dynamics
   * run: 202 timeline events, 201 samples over ticks 0..200, and a declared
   * 20 ms tick.
   */
  it("plays the measured run in its declared four-second simulated duration", () => {
    const cadence = derivePlaybackCadence(measuredRunInput(1));

    assert.equal(cadence.cursorsPerSecond, 50.25);
    assert.equal(cadence.declaredTiming, true);
    assert.equal(cadence.realTime, true);
    assert.equal(cadence.realDurationMs, 4_000);
    assert.equal(playbackCadenceReadout(cadence), "50 steps/s · real time");

    const cursors = frameWalk(cadence, 4_020);
    assert.ok(cursorAtElapsed(0, 3_900, cadence, 201) < 201);
    assert.equal(cursorAtElapsed(0, 4_020, cadence, 201), 201);
    assertMonotone(cursors);
  });

  /**
   * The speed cases reuse the measured B146 run shape above; 0.5x, 4x, and
   * 8x are the scrub bar's existing multiplier options.
   */
  it("applies speed as a real-time multiplier, including multi-step frames", () => {
    assert.equal(derivePlaybackCadence(measuredRunInput(0.5)).realDurationMs, 8_000);
    assert.equal(derivePlaybackCadence(measuredRunInput(4)).realDurationMs, 1_000);

    const eightTimes = derivePlaybackCadence(measuredRunInput(8));
    assert.equal(eightTimes.cursorsPerSecond, 402);
    assert.equal(eightTimes.realDurationMs, 500);
    const cursors = frameWalk(eightTimes, 520);
    assert.equal(cursors.at(-1), 201);
    assert.ok(cursors.every((cursor) => cursor <= 201));
    assertMonotone(cursors);
  });

  it("preserves existing one-step-per-second base pacing without declared timing", () => {
    const cadence = derivePlaybackCadence({ eventCount: 20, speed: 1 });

    for (const speed of [0.5, 1, 2, 4, 8]) {
      assert.equal(derivePlaybackCadence({ eventCount: 20, speed }).cursorsPerSecond, speed);
    }
    assert.equal(cadence.cursorsPerSecond, 1);
    assert.equal(cadence.declaredTiming, false);
    assert.equal(cadence.realTime, false);
    assert.equal(playbackCadenceReadout(cadence), "1.0 steps/s");
    assert.equal(cursorAtElapsed(0, 1_000, cadence, 19), 1);
    assert.equal(cursorAtElapsed(0, 4_000, cadence, 19), 4);
  });

  it("floors a slow-tick trace to a watchable rate", () => {
    const cadence = derivePlaybackCadence({
      eventCount: 5_000,
      firstTick: 0,
      lastTick: 480,
      tickDurationMs: 60_000,
      speed: 1,
    });

    assert.equal(cadence.cursorsPerSecond, 1);
    assert.ok(cadence.cursorsPerSecond >= 1);
    assert.equal(cadence.declaredTiming, true);
    assert.equal(cadence.realTime, false);
    assert.equal(playbackCadenceReadout(cadence), "1.0 steps/s · faster than real time");
  });

  it("floors a one-hour tick to one watchable step per second times speed", () => {
    const cadence = derivePlaybackCadence({
      eventCount: 61,
      firstTick: 0,
      lastTick: 60,
      tickDurationMs: 3_600_000,
      speed: 4,
    });

    assert.equal(cadence.cursorsPerSecond, 4);
    assert.equal(Number.isFinite(cadence.cursorsPerSecond), true);
    assert.equal(cadence.declaredTiming, true);
    assert.equal(cadence.realTime, false);
  });

  it("keeps a one-millisecond tick finite and lands on the final cursor", () => {
    const maxCursor = 1_000;
    const cadence = derivePlaybackCadence({
      eventCount: maxCursor + 1,
      firstTick: 0,
      lastTick: maxCursor,
      tickDurationMs: 1,
      speed: 8,
    });
    const cursors = frameWalk(cadence, 140, maxCursor);

    assert.equal(cadence.cursorsPerSecond, 8_000);
    assert.equal(Number.isFinite(cadence.cursorsPerSecond), true);
    assert.ok(cadence.cursorsPerSecond > 0);
    assert.equal(cursors.at(-1), maxCursor);
    assert.ok(cursors.every((cursor) => cursor <= maxCursor));
    assertMonotone(cursors);
  });

  /**
   * These zero, negative, non-finite, and zero-span values are the boundary
   * inputs enumerated by the B146 cadence contract.
   */
  it("returns a finite positive rate for every degenerate input", () => {
    const inputs: PlaybackCadenceInput[] = [
      { eventCount: 0, speed: 1 },
      { eventCount: 1, speed: 1 },
      { eventCount: 202, firstTick: 7, lastTick: 7, tickDurationMs: 20, speed: 1 },
      { ...measuredRunInput(1), tickDurationMs: 0 },
      { ...measuredRunInput(1), tickDurationMs: -20 },
      { ...measuredRunInput(1), tickDurationMs: Number.NaN },
      { ...measuredRunInput(1), tickDurationMs: Number.POSITIVE_INFINITY },
      { ...measuredRunInput(1), speed: 0 },
      { ...measuredRunInput(1), speed: -1 },
      { ...measuredRunInput(1), speed: Number.NaN },
    ];

    for (const input of inputs) {
      const rate = derivePlaybackCadence(input).cursorsPerSecond;
      assert.equal(Number.isFinite(rate), true);
      assert.equal(Number.isNaN(rate), false);
      assert.ok(rate > 0);
    }
  });
});

describe("cursorAtElapsed", () => {
  it("returns stable values for no-op frames and changes once per second", () => {
    const cadence = derivePlaybackCadence({ eventCount: 20, speed: 1 });
    const cursors = Array.from(
      { length: 121 },
      (_, frame) => cursorAtElapsed(0, frame / 60 * 1_000, cadence, 19),
    );
    const changes = cursors.flatMap((cursor, frame) => (
      frame > 0 && cursor !== cursors[frame - 1] ? [[frame, cursor] as const] : []
    ));

    assert.deepEqual([...new Set(cursors.slice(0, 60))], [0]);
    assert.deepEqual([...new Set(cursors.slice(60, 120))], [1]);
    assert.deepEqual(changes, [[60, 1], [120, 2]]);
  });

  /**
   * The 120 re-anchor is the specified mid-pass user-scrub case; the other
   * values exercise the elapsed-time guards and max-cursor contract directly.
   */
  it("clamps, stays monotone, ignores invalid elapsed time, and honors re-anchors", () => {
    const cadence = derivePlaybackCadence(measuredRunInput(1));

    assert.equal(cursorAtElapsed(190, 1_000, cadence, 201), 201);
    assert.equal(cursorAtElapsed(120, 0, cadence, 201), 120);
    assert.equal(cursorAtElapsed(120, -5, cadence, 201), 120);
    assert.equal(cursorAtElapsed(120, Number.NaN, cadence, 201), 120);

    const elapsed = [1, 16.6667, 100, 500, 1_000, 4_020];
    const cursors = elapsed.map((elapsedMs) => cursorAtElapsed(0, elapsedMs, cadence, 201));
    assertMonotone(cursors);

    assert.equal(cursorAtElapsed(120, 0, cadence, 201), 120);
    assert.equal(cursorAtElapsed(120, 100, cadence, 201), 125);
  });
});

describe("simulated-time master clock with many events per tick", () => {
  const maxCursor = 18_001;
  const lastTick = 2_000;
  const tickDurationMs = 20;
  const events = Array.from({ length: maxCursor + 1 }, (_, index) => {
    const tick = Math.min(Math.floor(index / 9), lastTick);
    return { recordedAt: new Date(tick * tickDurationMs).toISOString() };
  });
  const manyEventsInput = (speed: number): PlaybackCadenceInput => ({
    eventCount: events.length,
    events,
    firstTick: 0,
    lastTick,
    tickDurationMs,
    speed,
  });

  it("derives duration and endpoint ticks from the trace's timestamps", () => {
    const cadence = derivePlaybackCadence(manyEventsInput(1));
    const halfSpeed = derivePlaybackCadence(manyEventsInput(0.5));

    assert.equal(cadence.realDurationMs, 40_000);
    assert.equal(halfSpeed.realDurationMs, 80_000);
    assert.equal(playbackTickAtCursor(cadence, 0), 0);
    assert.equal(playbackTickAtCursor(cadence, maxCursor), lastTick);
  });

  it("returns whole ticks across millisecond-truncated ledger timestamps", () => {
    const truncatedLastTick = 1_000;
    const ledgerTickDurationMs = 20;
    const ledgerEvents = Array.from({ length: truncatedLastTick + 1 }, (_, tick) => ({
      recordedAt: new Date(tick * 0.02 * 1_000).toISOString(),
    }));
    const cadence = derivePlaybackCadence({
      eventCount: ledgerEvents.length,
      events: ledgerEvents,
      firstTick: 0,
      lastTick: truncatedLastTick,
      tickDurationMs: ledgerTickDurationMs,
      speed: 1,
    });

    assert.equal(Date.parse(ledgerEvents[803]!.recordedAt) / ledgerTickDurationMs, 802.95);
    for (let cursor = 0; cursor <= truncatedLastTick; cursor += 1) {
      const tick = playbackTickAtCursor(cadence, cursor);
      assert.equal(tick, cursor);
      assert.equal(Number.isInteger(tick), true);
    }
    assert.equal(playbackTickAtCursor(cadence, 0), 0);
    assert.equal(playbackTickAtCursor(cadence, truncatedLastTick), truncatedLastTick);
  });

  it("keeps the bar and spatial motion together through the end", () => {
    const cadence = derivePlaybackCadence(manyEventsInput(1));
    const finalCursor = cursorAtElapsed(0, 40_000, cadence, maxCursor);

    assert.ok(cursorAtElapsed(0, 39_000, cadence, maxCursor) < maxCursor);
    assert.equal(finalCursor, maxCursor);
    assert.equal(playbackTickAtCursor(cadence, finalCursor), lastTick);
  });

  it("tracks simulated time at the selected playback speed", () => {
    const cadence = derivePlaybackCadence(manyEventsInput(1));
    const halfSpeed = derivePlaybackCadence(manyEventsInput(0.5));
    const cursor = cursorAtElapsed(0, 4_480, cadence, maxCursor);
    const halfSpeedCursor = cursorAtElapsed(0, 4_480, halfSpeed, maxCursor);

    assert.equal(playbackTickAtCursor(cadence, cursor), 224);
    assert.equal(playbackTickAtCursor(halfSpeed, halfSpeedCursor), 112);
  });

  it("advances a continuous presentation tick between sparse events", () => {
    const sparseEvents = Array.from({ length: 5 }, (_, index) => ({
      recordedAt: new Date(index * 1_000).toISOString(),
    }));
    const cadence = derivePlaybackCadence({
      eventCount: sparseEvents.length,
      events: sparseEvents,
      firstTick: 0,
      lastTick: 200,
      tickDurationMs: 20,
      speed: 1,
    });

    assert.equal(cursorAtElapsed(0, 16, cadence, 4), 0);
    assert.equal(playbackTickAtCursor(cadence, 0), 0);
    assert.equal(playbackTickAtElapsed(0, 16, cadence), 0.8);
    assert.equal(playbackTickAtElapsed(0, 500, cadence), 25);
    assert.equal(playbackTickAtElapsed(0, 9_000, cadence), 200);
  });

  it("advances from a recorded world-tick anchor when wall time is not the world clock", () => {
    const cadence = derivePlaybackCadence({
      eventCount: 288,
      firstTick: 0,
      lastTick: 6_051,
      tickDurationMs: 20,
      speed: 2,
    });

    assert.equal(playbackTickAtCursor(cadence, 68), undefined);
    assert.equal(playbackTickAtElapsed(68, 16, cadence, 1_430, 6_051), 1_431.6);
    assert.equal(playbackTickAtElapsed(68, 100_000, cadence, 1_430, 6_051), 6_051);
  });

  it("preserves a one-event-per-tick timestamped trace", () => {
    const oneToOneEvents = Array.from({ length: 202 }, (_, index) => ({
      recordedAt: new Date(Math.min(index, 200) * tickDurationMs).toISOString(),
    }));
    const cadence = derivePlaybackCadence({
      eventCount: oneToOneEvents.length,
      events: oneToOneEvents,
      firstTick: 0,
      lastTick: 200,
      tickDurationMs,
      speed: 1,
    });
    const finalCursor = cursorAtElapsed(0, 4_000, cadence, 201);

    assert.equal(cadence.realDurationMs, 4_000);
    assert.equal(finalCursor, 201);
    assert.equal(playbackTickAtCursor(cadence, finalCursor), 200);
  });

  it("falls back when timestamps do not corroborate the declared tick span", () => {
    const wallClockEvents = events.map((_, index) => ({
      recordedAt: new Date(index / maxCursor * 3 * 60 * 60 * 1_000).toISOString(),
    }));
    const cadence = derivePlaybackCadence({
      ...manyEventsInput(1),
      events: wallClockEvents,
    });
    const noEventsCadence = derivePlaybackCadence({
      ...manyEventsInput(1),
      events: undefined,
    });

    assert.equal(playbackTickAtCursor(cadence, 1_000), undefined);
    for (const elapsedMs of [1, 16, 1_000, 4_480, 40_000]) {
      assert.equal(
        cursorAtElapsed(0, elapsedMs, cadence, maxCursor),
        cursorAtElapsed(0, elapsedMs, noEventsCadence, maxCursor),
      );
    }
  });

  it("leaves a trace with no declared timing on event-uniform pacing", () => {
    const cadence = derivePlaybackCadence({
      eventCount: events.length,
      events,
      speed: 1,
    });

    assert.equal(playbackTickAtCursor(cadence, 0), undefined);
    assert.equal(cursorAtElapsed(0, 1_000, cadence, maxCursor), 1);
  });

  it("tracks simulated time when event density is non-uniform", () => {
    const nonUniformEvents = Array.from({ length: 2_001 }, (_, tick) => (
      Array.from({ length: tick >= 1_000 && tick < 2_000 ? 17 : 1 }, () => ({
        recordedAt: new Date(tick * 20).toISOString(),
      }))
    )).flat();
    const nonUniformMaxCursor = nonUniformEvents.length - 1;
    const input: PlaybackCadenceInput = {
      eventCount: nonUniformEvents.length,
      events: nonUniformEvents,
      firstTick: 0,
      lastTick: 2_000,
      tickDurationMs: 20,
      speed: 1,
    };
    const cadence = derivePlaybackCadence(input);
    const halfPassCursor = cursorAtElapsed(0, 20_000, cadence, nonUniformMaxCursor);
    const fallback = derivePlaybackCadence({ ...input, events: undefined });
    const fallbackCursor = cursorAtElapsed(0, 20_000, fallback, nonUniformMaxCursor);

    assert.equal(playbackTickAtCursor(cadence, halfPassCursor), 1_000);
    assert.notEqual(halfPassCursor, fallbackCursor);
    assert.ok(playbackTickAtCursor(cadence, fallbackCursor)! > 1_400);
    assert.equal(cursorAtElapsed(0, 40_000, cadence, nonUniformMaxCursor), nonUniformMaxCursor);
    assert.equal(playbackTickAtCursor(cadence, nonUniformMaxCursor), 2_000);
    assert.ok(cursorAtElapsed(0, 39_000, cadence, nonUniformMaxCursor) < nonUniformMaxCursor);
    assertMonotone(frameWalk(cadence, 40_000, nonUniformMaxCursor));
  });

  it("guards simulated time against a genuine two-second wall clock", async () => {
    const cadence = derivePlaybackCadence(manyEventsInput(1));
    const start = performance.now();
    let elapsedMs = 0;
    let finalCursor = 0;

    do {
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
      elapsedMs = performance.now() - start;
      finalCursor = cursorAtElapsed(0, elapsedMs, cadence, maxCursor);
    } while (elapsedMs < 2_000);

    const finalTick = playbackTickAtCursor(cadence, finalCursor);
    assert.notEqual(finalTick, undefined);
    assert.ok(Math.abs(finalTick! - elapsedMs / tickDurationMs) <= 2);
  });
});

describe("spatial-sample master clock", () => {
  it("keeps sparse sample playback aligned when the watchability floor wins", () => {
    const events = [0, 100, 200].map((tick) => ({
      payload: { tick },
      recordedAt: `tick ${tick}`,
      type: "spatial.sample",
    }));
    const cadence = derivePlaybackCadence({
      eventCount: events.length,
      events,
      firstTick: 0,
      lastTick: 200,
      speed: 1,
      tickDurationMs: 20,
    });

    assert.equal(cadence.realTime, false);
    assert.equal(cadence.realDurationMs, 2_000);
    assert.equal(cursorAtElapsed(0, 999, cadence, 2), 0);
    assert.equal(cursorAtElapsed(0, 1_000, cadence, 2), 1);
    assert.equal(cursorAtElapsed(0, 2_000, cadence, 2), 2);
    assert.equal(playbackTickAtElapsed(0, 2_000, cadence), 200);
  });
});
