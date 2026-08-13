import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ViewerSpatialSample } from "./types.js";
import {
  spatialObjectAtPresentationTick,
  spatialObjectAtTick,
  spatialSampleAtTick,
} from "./spatialObjectModel.js";

const samples: ViewerSpatialSample[] = [
  { occupancy: {}, objects: [{ id: "red", position: [-2, 0], velocity: [1, 0] }], tick: 2, transit: [] },
  { occupancy: {}, objects: [{ id: "red", position: [-1, 0], velocity: [0.5, 0] }], tick: 4, transit: [] },
];

describe("spatialObjectModel", () => {
  it("uses only the newest authoritative sample at or before the cursor", () => {
    assert.equal(spatialSampleAtTick(samples, 1), undefined);
    assert.deepEqual(spatialObjectAtTick(samples, 3, "red"), samples[0]!.objects![0]);
    assert.deepEqual(spatialObjectAtTick(samples, 4, "red"), samples[1]!.objects![0]);
  });

  it("does not invent missing objects", () => {
    assert.equal(spatialObjectAtTick(samples, 4, "blue"), undefined);
  });

  it("interpolates presentation smoothly and arrives exactly at authoritative samples", () => {
    const motion: ViewerSpatialSample[] = [
      { occupancy: {}, objects: [{ id: "ball", position: [0, 0], velocity: [10, 0] }], tick: 0, transit: [] },
      { occupancy: {}, objects: [{ id: "ball", position: [10, 4], velocity: [0, 0] }], tick: 100, transit: [] },
    ];
    const halfway = spatialObjectAtPresentationTick(motion, 50, "ball", 20)!;
    assert.ok(halfway.position[0] > 5);
    assert.equal(halfway.position[1], 2);
    assert.deepEqual(
      spatialObjectAtPresentationTick(motion, 100, "ball", 20),
      motion[1]!.objects![0],
    );
    assert.deepEqual(motion[0]!.objects![0]!.position, [0, 0]);
  });

  it("interprets fixture velocities in meters per simulated second", () => {
    const matterMotion: ViewerSpatialSample[] = [
      { occupancy: {}, objects: [{ id: "red", position: [0, 0], velocity: [18, 0] }], tick: 0, transit: [] },
      { occupancy: {}, objects: [{ id: "red", position: [1.8, 0], velocity: [18, 0] }], tick: 5, transit: [] },
    ];
    const halfway = spatialObjectAtPresentationTick(matterMotion, 2.5, "red", 20);
    assert.ok(halfway);
    assert.ok(halfway.position[0] > 0.89 && halfway.position[0] < 0.91);
  });

  it("does not overshoot or face backward when endpoint velocity opposes displacement", () => {
    const motion: ViewerSpatialSample[] = [
      { occupancy: {}, objects: [{ id: "body", position: [0, 0], velocity: [-9, 4] }], tick: 0, transit: [] },
      { occupancy: {}, objects: [{ id: "body", position: [10, 0], velocity: [-5, -3] }], tick: 100, transit: [] },
    ];
    const positions = Array.from({ length: 101 }, (_, tick) =>
      spatialObjectAtPresentationTick(motion, tick, "body", 20)!).filter(Boolean);

    assert.ok(positions.every(({ position }) => position[0] >= 0 && position[0] <= 10));
    assert.ok(positions.every(({ position }) => position[1] === 0));
    assert.ok(positions.slice(1, -1).every(({ velocity }) => velocity![0] >= 0));
    for (let index = 1; index < positions.length; index += 1) {
      assert.ok(positions[index]!.position[0] >= positions[index - 1]!.position[0]);
    }
  });

  it("cuts rather than interpolates across an authored discontinuity", () => {
    const reset: ViewerSpatialSample[] = [
      { occupancy: {}, objects: [{ id: "ball", position: [10, 0], velocity: [4, 0] }], tick: 90, transit: [] },
      { discontinuities: ["ball"], occupancy: {}, objects: [{ id: "ball", position: [0, 0], velocity: [0, 0] }], tick: 100, transit: [] },
    ];
    assert.deepEqual(
      spatialObjectAtPresentationTick(reset, 99.9, "ball", 20)?.position,
      [10, 0],
    );
    assert.deepEqual(
      spatialObjectAtPresentationTick(reset, 100, "ball", 20)?.position,
      [0, 0],
    );
  });

  it("cuts an impossible legacy teleport even without a discontinuity marker", () => {
    const legacy: ViewerSpatialSample[] = [
      { occupancy: {}, objects: [{ id: "ball", position: [11, 0], velocity: [0, 0] }], tick: 90, transit: [] },
      { occupancy: {}, objects: [{ id: "ball", position: [0, 0], velocity: [0, 0] }], tick: 100, transit: [] },
    ];
    assert.deepEqual(
      spatialObjectAtPresentationTick(legacy, 95, "ball", 20)?.position,
      [11, 0],
    );
    assert.deepEqual(
      spatialObjectAtPresentationTick(legacy, 100, "ball", 20)?.position,
      [0, 0],
    );
  });
});
