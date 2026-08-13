import type { AgentPlacement } from "./sceneMotion.js";
import { spatialObjectAtPresentationTick } from "./spatialObjectModel.js";
import type { ViewerNode, ViewerSpatialSample } from "./types.js";

const movingThresholdMps = 0.15;
const headingDeadbandMps = 0.25;
const walkRunThresholdMps = 2.2;

export const applySpatialSamplesToNodes = (
  nodes: readonly ViewerNode[],
  samples: readonly ViewerSpatialSample[],
  tick: number,
  tickDurationMs = 20,
): ViewerNode[] => {
  return nodes.map((node) => {
    const object = spatialObjectAtPresentationTick(
      samples,
      tick,
      node.id,
      tickDurationMs,
    );
    if (object === undefined) return node;
    const speed = object.velocity === undefined ? 0 : Math.hypot(...object.velocity);
    return {
      ...node,
      in_transit: speed > movingThresholdMps,
      scene: [object.position[0], object.position[1], node.scene[2]],
      subtitle: object.velocity === undefined ? "position sampled" : `moving · speed ${speed.toFixed(2)}`,
      transit_heading: spatialHeadingAtTick(
        samples,
        tick,
        node.id,
        tickDurationMs,
      ) ?? node.transit_heading,
      value: `${object.position[0].toFixed(2)}, ${object.position[1].toFixed(2)}`,
    };
  });
};

export const applySpatialSamplesToPlacements = (
  placements: readonly AgentPlacement[],
  samples: readonly ViewerSpatialSample[],
  tick: number,
  tickDurationMs = 20,
): AgentPlacement[] => {
  return placements.map((placement) => {
    const object = spatialObjectAtPresentationTick(
      samples,
      tick,
      placement.node.id,
      tickDurationMs,
    );
    if (object === undefined) return placement;
    const velocity = object.velocity ?? [0, 0];
    const speed = Math.hypot(...velocity);
    const animation = locomotionAtTick(speed, tick, tickDurationMs);
    const position: [number, number, number] = [
      object.position[0],
      object.position[1],
      placement.position[2],
    ];
    return {
      ...placement,
      animation,
      heading: spatialHeadingAtTick(
        samples,
        tick,
        placement.node.id,
        tickDurationMs,
      ) ?? placement.heading,
      labelPosition: [position[0], position[1], position[2] + 0.72],
      moving: speed > movingThresholdMps,
      position,
      speedMps: speed,
    };
  });
};

export const locomotionAtTick = (
  speedMps: number,
  tick: number,
  tickDurationMs: number,
): AgentPlacement["animation"] => {
  const seconds = tick * tickDurationMs / 1_000;
  if (speedMps < movingThresholdMps) {
    return { clip: "idle", phase: seconds % 4 / 4, timeScale: 1 };
  }
  if (speedMps < walkRunThresholdMps) {
    const timeScale = Math.max(0.35, speedMps / 1.4);
    return { clip: "walk", phase: seconds * 1.6 * timeScale % 1, timeScale };
  }
  const timeScale = Math.max(0.45, speedMps / 5.5);
  return { clip: "run", phase: seconds * 2.4 * timeScale % 1, timeScale };
};

export const spatialHeadingAtTick = (
  samples: readonly ViewerSpatialSample[],
  tick: number,
  id: string,
  tickDurationMs: number,
): number | undefined => {
  const current = spatialObjectAtPresentationTick(samples, tick, id, tickDurationMs);
  const currentVelocity = current?.velocity;
  if (currentVelocity && Math.hypot(...currentVelocity) >= headingDeadbandMps) {
    return Math.atan2(currentVelocity[1], currentVelocity[0]);
  }
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const sample = samples[index]!;
    if (sample.tick > tick) continue;
    const velocity = sample.objects?.find((object) => object.id === id)?.velocity;
    if (velocity && Math.hypot(...velocity) >= headingDeadbandMps) {
      return Math.atan2(velocity[1], velocity[0]);
    }
  }
  return undefined;
};
