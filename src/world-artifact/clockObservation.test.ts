import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorldSidecarClockObservation,
  parseWorldSidecarClockObservation,
  WORLD_SIDECAR_CLOCK_PATH,
} from "./clockObservation.js";

const observation = () => ({
  action_count: 0,
  clock: { completed_tick: 1, next_tick: 2, state: "running" as const },
  run_id: "run-one",
  version: "simfile.world-sidecar-clock.v1" as const,
  world_instance_id: "world-one",
});

test("world clock observation exposes exact zero-action runtime progress", () => {
  assert.equal(WORLD_SIDECAR_CLOCK_PATH, "/v1/world/clock");
  assert.deepEqual(createWorldSidecarClockObservation(observation()), observation());
  assert.deepEqual(parseWorldSidecarClockObservation({
    ...observation(), clock: { completed_tick: 0, next_tick: 1, state: "running" },
  }).clock, { completed_tick: 0, next_tick: 1, state: "running" });
});

test("world clock observation rejects synthesized or uncorrelated state", () => {
  const valid = observation();
  for (const forged of [
    { ...valid, action_count: -1 },
    { ...valid, clock: { ...valid.clock, next_tick: 3 } },
    { ...valid, clock: { ...valid.clock, state: "paused" } },
    { ...valid, run_id: "../foreign" },
    { ...valid, version: "simfile.world-sidecar-clock.latest" },
    { ...valid, extra: true },
  ]) assert.throws(() => parseWorldSidecarClockObservation(forged));
});
