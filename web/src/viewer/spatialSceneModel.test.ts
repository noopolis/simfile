import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentPlacement } from "./sceneMotion.js";
import {
  applySpatialSamplesToNodes,
  applySpatialSamplesToPlacements,
  locomotionAtTick,
} from "./spatialSceneModel.js";
import type { ViewerNode, ViewerSpatialSample } from "./types.js";

const node = (id: string, kind: ViewerNode["kind"] = "agent"): ViewerNode => ({
  camera: [0.5, 0.5],
  colorRole: kind === "agent" ? "agent" : "marker",
  detail: id,
  id,
  kind,
  label: id,
  scale: 0.2,
  scene: [0, 0, 0.1],
  scope: `${kind}:${id}`,
  subtitle: id,
  value: "pitch",
  x: 0,
  y: 0,
});
const samples: ViewerSpatialSample[] = [{
  occupancy: { pitch: ["red"] },
  objects: [
    { id: "red", position: [-2, 1], velocity: [1, 0] },
    { id: "ball", position: [0.5, -1], velocity: [0, 0] },
  ],
  tick: 4,
  transit: [],
}];

describe("spatial GlyphCSS scene model", () => {
  it("places agents and signals from the exact authoritative sample", () => {
    const nodes = applySpatialSamplesToNodes([node("red"), node("ball", "marker")], samples, 4);
    assert.deepEqual(nodes.map(({ id, scene }) => [id, scene]), [
      ["red", [-2, 1, 0.1]],
      ["ball", [0.5, -1, 0.1]],
    ]);
    assert.equal(nodes[0]?.in_transit, true);
    assert.equal(nodes[1]?.in_transit, false);
  });

  it("moves the GlyphCSS avatar without mutating its source placement", () => {
    const originalNode = node("red");
    const placement: AgentPlacement = {
      animation: { clip: "idle", phase: 0, timeScale: 1 },
      heading: 1,
      labelPosition: [0, 0, 0.8],
      moving: false,
      nextRoomId: "pitch",
      node: originalNode,
      position: [0, 0, 0.1],
      roomId: "pitch",
      speedMps: 0,
      stride: 0,
    };
    const projected = applySpatialSamplesToPlacements([placement], samples, 4)[0]!;
    assert.deepEqual(projected.position, [-2, 1, 0.1]);
    assert.deepEqual(projected.labelPosition, [-2, 1, 0.82]);
    assert.equal(projected.moving, true);
    assert.equal(projected.animation.clip, "walk");
    assert.equal(projected.heading, 0);
    assert.equal(projected.speedMps, 1);
    assert.deepEqual(placement.position, [0, 0, 0.1]);
  });

  it("holds facing through idle and derives clip phase only from simulated time", () => {
    const stopped: ViewerSpatialSample[] = [
      ...samples,
      {
        occupancy: { pitch: ["red"] },
        objects: [{ id: "red", position: [-1.9, 1], velocity: [0, 0] }],
        tick: 5,
        transit: [],
      },
    ];
    const placement = {
      ...applySpatialSamplesToPlacements(
        [{
          animation: { clip: "idle" as const, phase: 0, timeScale: 1 },
          heading: 1,
          labelPosition: [0, 0, 0.8] as [number, number, number],
          moving: false,
          nextRoomId: "pitch",
          node: node("red"),
          position: [0, 0, 0.1] as [number, number, number],
          roomId: "pitch",
          speedMps: 0,
          stride: 0,
        }],
        stopped,
        5,
      )[0]!,
    };
    assert.equal(placement.heading, 0);
    assert.equal(placement.animation.clip, "idle");
    assert.deepEqual(locomotionAtTick(5.5, 125, 20), locomotionAtTick(5.5, 125, 20));
    assert.notDeepEqual(locomotionAtTick(5.5, 125, 20), locomotionAtTick(5.5, 126, 20));
  });
});
