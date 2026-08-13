import type {
  ViewerExtensionSpatialObject,
  ViewerExtensionSpatialSample,
} from "./index.js";

const presentationTickDurationMs = 20;
const movingThresholdMps = 0.15;
const headingDeadbandMps = 0.25;
const walkRunThresholdMps = 2.2;

export interface ViewerExtensionLocomotion {
  readonly clip: "idle" | "walk" | "run";
  readonly phase: number;
  readonly timeScale: number;
}

const clampTangent = (value: number, displacement: number): number => {
  if (displacement === 0 || value * displacement <= 0) return 0;
  const bound = Math.abs(displacement) * 3;
  return Math.sign(displacement) * Math.min(bound, Math.abs(value));
};

const interpolateAxis = (
  from: number,
  to: number,
  fromVelocity: number,
  toVelocity: number,
  ratio: number,
  durationSeconds: number,
): number => {
  const ratio2 = ratio * ratio;
  const ratio3 = ratio2 * ratio;
  const displacement = to - from;
  const fromTangent = clampTangent(fromVelocity * durationSeconds, displacement);
  const toTangent = clampTangent(toVelocity * durationSeconds, displacement);
  return (2 * ratio3 - 3 * ratio2 + 1) * from
    + (ratio3 - 2 * ratio2 + ratio) * fromTangent
    + (-2 * ratio3 + 3 * ratio2) * to
    + (ratio3 - ratio2) * toTangent;
};

const interpolatedVelocity = (
  from: number,
  to: number,
  fromVelocity: number,
  toVelocity: number,
  ratio: number,
  durationSeconds: number,
): number => {
  const displacement = to - from;
  const fromTangent = clampTangent(fromVelocity * durationSeconds, displacement);
  const toTangent = clampTangent(toVelocity * durationSeconds, displacement);
  const ratio2 = ratio * ratio;
  const derivative = (6 * ratio2 - 6 * ratio) * from
    + (3 * ratio2 - 4 * ratio + 1) * fromTangent
    + (-6 * ratio2 + 6 * ratio) * to
    + (3 * ratio2 - 2 * ratio) * toTangent;
  return derivative / durationSeconds;
};

const isImplicitDiscontinuity = (
  prior: ViewerExtensionSpatialObject,
  next: ViewerExtensionSpatialObject,
  durationTicks: number,
  tickDurationMs: number,
): boolean => {
  if (durationTicks <= 0 || tickDurationMs <= 0) return true;
  const displacement = Math.hypot(
    next.position[0]! - prior.position[0]!,
    next.position[1]! - prior.position[1]!,
  );
  const endpointSpeedPerSecond = Math.max(
    Math.hypot(...(prior.velocity ?? [0, 0])),
    Math.hypot(...(next.velocity ?? [0, 0])),
  );
  const ticksPerSecond = 1_000 / tickDurationMs;
  const sampledSpeedPerSecond = displacement / durationTicks * ticksPerSecond;
  return sampledSpeedPerSecond > Math.max(12, endpointSpeedPerSecond * 4 + 2);
};

export const spatialObjectAtPresentationTick = (
  samples: readonly ViewerExtensionSpatialSample[],
  tick: number,
  id: string,
  tickDurationMs = presentationTickDurationMs,
): ViewerExtensionSpatialObject | undefined => {
  const priorIndex = samples.findLastIndex((sample) => sample.tick <= tick);
  if (priorIndex < 0) return undefined;
  const prior = samples[priorIndex]!;
  const priorObject = prior.objects?.find((object) => object.id === id);
  const next = samples[priorIndex + 1];
  if (prior.tick === tick || next === undefined || priorObject === undefined) {
    return priorObject;
  }
  const nextObject = next.objects?.find((object) => object.id === id);
  if (nextObject === undefined || next.discontinuities?.includes(id)) {
    return priorObject;
  }
  const tickSpan = next.tick - prior.tick;
  if (tickSpan <= 0
    || isImplicitDiscontinuity(priorObject, nextObject, tickSpan, tickDurationMs)) {
    return priorObject;
  }
  const ratio = Math.max(0, Math.min(1, (tick - prior.tick) / tickSpan));
  if (ratio >= 1) return nextObject;
  const fromVelocity = priorObject.velocity ?? [0, 0];
  const toVelocity = nextObject.velocity ?? [0, 0];
  const durationSeconds = tickSpan * tickDurationMs / 1_000;
  return Object.freeze({
    id,
    position: Object.freeze([
      interpolateAxis(
        priorObject.position[0]!,
        nextObject.position[0]!,
        fromVelocity[0]!,
        toVelocity[0]!,
        ratio,
        durationSeconds,
      ),
      interpolateAxis(
        priorObject.position[1]!,
        nextObject.position[1]!,
        fromVelocity[1]!,
        toVelocity[1]!,
        ratio,
        durationSeconds,
      ),
    ] as [number, number]),
    velocity: Object.freeze([
      interpolatedVelocity(
        priorObject.position[0]!, nextObject.position[0]!,
        fromVelocity[0]!, toVelocity[0]!, ratio, durationSeconds,
      ),
      interpolatedVelocity(
        priorObject.position[1]!, nextObject.position[1]!,
        fromVelocity[1]!, toVelocity[1]!, ratio, durationSeconds,
      ),
    ] as [number, number]),
  });
};

export const locomotionAtTick = (
  speedMps: number,
  tick: number,
  tickDurationMs: number,
): ViewerExtensionLocomotion => {
  const seconds = tick * tickDurationMs / 1_000;
  if (speedMps < movingThresholdMps) {
    return Object.freeze({ clip: "idle", phase: seconds % 4 / 4, timeScale: 1 });
  }
  if (speedMps < walkRunThresholdMps) {
    const timeScale = Math.max(0.35, speedMps / 1.4);
    return Object.freeze({
      clip: "walk",
      phase: seconds * 1.6 * timeScale % 1,
      timeScale,
    });
  }
  const timeScale = Math.max(0.45, speedMps / 5.5);
  return Object.freeze({
    clip: "run",
    phase: seconds * 2.4 * timeScale % 1,
    timeScale,
  });
};

export const spatialHeadingAtTick = (
  samples: readonly ViewerExtensionSpatialSample[],
  tick: number,
  id: string,
  tickDurationMs: number,
): number | undefined => {
  const current = spatialObjectAtPresentationTick(
    samples,
    tick,
    id,
    tickDurationMs,
  );
  const currentVelocity = current?.velocity;
  if (currentVelocity && Math.hypot(...currentVelocity) >= headingDeadbandMps) {
    return Math.atan2(currentVelocity[1]!, currentVelocity[0]!);
  }
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const sample = samples[index]!;
    if (sample.tick > tick) continue;
    const velocity = sample.objects?.find((object) => object.id === id)?.velocity;
    if (velocity && Math.hypot(...velocity) >= headingDeadbandMps) {
      return Math.atan2(velocity[1]!, velocity[0]!);
    }
  }
  return undefined;
};
