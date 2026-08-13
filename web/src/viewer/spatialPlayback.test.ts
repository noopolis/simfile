import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ViewerSpatialSample } from "./types.js";
import {
  advanceLiveSpatialPlayback,
  advanceSpatialPlayback,
  clampSpatialFrame,
  createLiveSpatialPlaybackState,
  createSpatialPlaybackAnimationClock,
  createSpatialPlaybackState,
  reconcileLiveSpatialPlayback,
  reconcileSpatialPlaybackSamples,
  scrubSpatialPlayback,
  setSpatialPlaybackPlaying,
  stepSpatialPlaybackAnimationClock,
  type SpatialPlaybackState,
} from "./spatialPlayback.js";

const samples: ViewerSpatialSample[] = [
  { occupancy: {}, tick: 0, transit: [] },
  { occupancy: {}, tick: 100, transit: [] },
  { occupancy: {}, tick: 350, transit: [] },
];

describe("spatial playback model", () => {
  it("plays at authoritative tick time and preserves pause", () => {
    const playing = setSpatialPlaybackPlaying(
      createSpatialPlaybackState(samples),
      samples,
      true,
    );
    const oneSecond = advanceSpatialPlayback(playing, samples, 1_000, 20, 1);
    assert.equal(oneSecond.tick, 50);
    assert.equal(oneSecond.frame, 0);
    const paused = setSpatialPlaybackPlaying(oneSecond, samples, false);
    assert.deepEqual(
      advanceSpatialPlayback(paused, samples, 5_000, 20, 1),
      paused,
    );
  });

  it("scrubs exactly and resumes from the selected authoritative frame", () => {
    assert.equal(clampSpatialFrame(99, samples.length), 2);
    const scrubbed = scrubSpatialPlayback(samples, 1);
    assert.deepEqual(scrubbed, {
      ended: false,
      frame: 1,
      playing: false,
      tick: 100,
    });
    const resumed = setSpatialPlaybackPlaying(scrubbed, samples, true);
    assert.equal(advanceSpatialPlayback(resumed, samples, 1_000, 20, 1).tick, 150);
  });

  it("applies speed without changing simulated-time semantics", () => {
    const playing = createSpatialPlaybackState(samples, true);
    assert.equal(advanceSpatialPlayback(playing, samples, 1_000, 20, 0.5).tick, 25);
    assert.equal(advanceSpatialPlayback(playing, samples, 1_000, 20, 1).tick, 50);
    assert.equal(advanceSpatialPlayback(playing, samples, 1_000, 20, 2).tick, 100);
  });

  it("uses only fake-rAF wall timestamps across sparse one-second samples", () => {
    const sparse: ViewerSpatialSample[] = Array.from({ length: 21 }, (_, second) => ({
      occupancy: {},
      tick: second * 50,
      transit: [],
    }));
    const runClock = (speed: 0.25 | 1, wallDurationMs: number) => {
      let clock = createSpatialPlaybackAnimationClock();
      let playback = createSpatialPlaybackState(sparse, true);
      for (let timestampMs = 0; timestampMs < wallDurationMs; timestampMs += 1_000 / 60) {
        const step = stepSpatialPlaybackAnimationClock(
          clock,
          playback,
          sparse,
          timestampMs,
          20,
          speed,
        );
        clock = step.clock;
        playback = step.playback;
      }
      const final = stepSpatialPlaybackAnimationClock(
        clock,
        playback,
        sparse,
        wallDurationMs,
        20,
        speed,
      );
      return final.playback;
    };

    assert.equal(runClock(1, 1_000).tick, 50);
    assert.equal(runClock(0.25, 4_000).tick, 50);
    assert.equal(runClock(1, 20_000).tick, 1_000);
    assert.equal(runClock(0.25, 80_000).tick, 1_000);
  });

  it("arrives exactly at the authoritative frontier and replay restarts", () => {
    const ended = advanceSpatialPlayback(
      createSpatialPlaybackState(samples, true),
      samples,
      10_000,
      20,
      2,
    );
    assert.deepEqual(ended, {
      ended: true,
      frame: 2,
      playing: false,
      tick: 350,
    });
    assert.deepEqual(setSpatialPlaybackPlaying(ended, samples, true), {
      ended: false,
      frame: 0,
      playing: true,
      tick: 0,
    });
  });

  it("keeps a paused DVR playhead rewound while ingestion advances", () => {
    const rewound = scrubSpatialPlayback(samples, 1);
    const appended: ViewerSpatialSample[] = [
      ...samples,
      { occupancy: {}, tick: 500, transit: [] },
    ];
    assert.deepEqual(
      reconcileSpatialPlaybackSamples(rewound, appended, false),
      {
        ended: false,
        frame: 1,
        playing: false,
        tick: 100,
      },
    );
  });

  it("continues an explicitly playing DVR when ingestion extends its frontier", () => {
    const atFrontier = scrubSpatialPlayback(samples, samples.length - 1);
    const appended: ViewerSpatialSample[] = [
      ...samples,
      { occupancy: {}, tick: 500, transit: [] },
    ];
    assert.deepEqual(
      reconcileSpatialPlaybackSamples(atFrontier, appended, true),
      {
        ended: false,
        frame: 2,
        playing: true,
        tick: 350,
      },
    );
  });

  it("cuts a stale DVR cursor to the oldest retained reconnect sample", () => {
    const stale: SpatialPlaybackState = {
      ended: false,
      frame: 0,
      playing: false,
      tick: 25,
    };
    assert.equal(
      reconcileSpatialPlaybackSamples(stale, samples.slice(1), false).tick,
      100,
    );
  });

  it("buffers live samples before advancing at exact simulated-time pace", () => {
    const starting: ViewerSpatialSample[] = [
      { occupancy: {}, tick: 0, transit: [] },
      { occupancy: {}, tick: 25, transit: [] },
    ];
    const waiting = createLiveSpatialPlaybackState(starting, 20);
    assert.deepEqual(waiting, {
      ended: false,
      frame: 0,
      playing: false,
      tick: 0,
    });
    const readySamples = [
      ...starting,
      { occupancy: {}, tick: 50, transit: [] },
    ];
    const ready = reconcileLiveSpatialPlayback(waiting, readySamples, 20);
    assert.equal(ready.playing, true);
    assert.equal(advanceLiveSpatialPlayback(ready, readySamples, 16, 20).tick, 0);
    const advancedSamples = [
      ...readySamples,
      { occupancy: {}, tick: 75, transit: [] },
    ];
    const advanced = advanceLiveSpatialPlayback(
      reconcileLiveSpatialPlayback(ready, advancedSamples, 20),
      advancedSamples,
      16,
      20,
    );
    assert.equal(advanced.tick, 0.8);
  });

  it("never extrapolates beyond the delayed live frontier", () => {
    const liveSamples: ViewerSpatialSample[] = [
      { occupancy: {}, tick: 0, transit: [] },
      { occupancy: {}, tick: 25, transit: [] },
      { occupancy: {}, tick: 75, transit: [] },
    ];
    const nearTarget: SpatialPlaybackState = {
      ended: false,
      frame: 1,
      playing: true,
      tick: 24,
    };
    const held = advanceLiveSpatialPlayback(nearTarget, liveSamples, 5_000, 20);
    assert.equal(held.tick, 25);
    assert.equal(
      advanceLiveSpatialPlayback(held, liveSamples, 16, 20),
      held,
    );
    assert.equal(
      advanceLiveSpatialPlayback(held, liveSamples, 20, 20, true).tick,
      26,
    );
  });

  it("bounds stale-tab correction to a separate two-buffer threshold", () => {
    const stale: SpatialPlaybackState = {
      ended: false,
      frame: 0,
      playing: true,
      tick: 0,
    };
    const advancedFrontier: ViewerSpatialSample[] = [
      { occupancy: {}, tick: 0, transit: [] },
      { occupancy: {}, tick: 200, transit: [] },
    ];
    const corrected = reconcileLiveSpatialPlayback(
      stale,
      advancedFrontier,
      20,
    );
    assert.equal(corrected.tick, 150);
  });
});
