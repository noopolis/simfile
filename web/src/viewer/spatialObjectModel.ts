import type { ViewerSpatialObjectSample, ViewerSpatialSample } from "./types.js";

const presentationTickDurationMs = 20;

export const spatialSampleAtTick = (
  samples: readonly ViewerSpatialSample[],
  tick: number,
): ViewerSpatialSample | undefined =>
  samples.filter((sample) => sample.tick <= tick).at(-1);

export const spatialObjectAtTick = (
  samples: readonly ViewerSpatialSample[],
  tick: number,
  id: string,
): ViewerSpatialObjectSample | undefined =>
  spatialSampleAtTick(samples, tick)?.objects?.find((object) => object.id === id);

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
  return ((6 * ratio2 - 6 * ratio) * from
    + (3 * ratio2 - 4 * ratio + 1) * fromTangent
    + (-6 * ratio2 + 6 * ratio) * to
    + (3 * ratio2 - 2 * ratio) * toTangent) / durationSeconds;
};

const isImplicitDiscontinuity = (
  prior: ViewerSpatialObjectSample,
  next: ViewerSpatialObjectSample,
  durationTicks: number,
  tickDurationMs: number,
): boolean => {
  if (durationTicks <= 0 || tickDurationMs <= 0) return true;
  const displacement = Math.hypot(
    next.position[0] - prior.position[0],
    next.position[1] - prior.position[1],
  );
  const endpointSpeedPerSecond = Math.max(
    Math.hypot(...(prior.velocity ?? [0, 0])),
    Math.hypot(...(next.velocity ?? [0, 0])),
  );
  const ticksPerSecond = 1_000 / tickDurationMs;
  const sampledSpeedPerSecond = displacement / durationTicks * ticksPerSecond;
  return sampledSpeedPerSecond > Math.max(12, endpointSpeedPerSecond * 4 + 2);
};

/**
 * Returns a presentation-only position between authoritative samples.
 * Discontinuities hold the prior value and cut exactly at the next sample.
 */
export const spatialObjectAtPresentationTick = (
  samples: readonly ViewerSpatialSample[],
  tick: number,
  id: string,
  tickDurationMs = presentationTickDurationMs,
): ViewerSpatialObjectSample | undefined => {
  const priorIndex = samples.findLastIndex((sample) => sample.tick <= tick);
  if (priorIndex < 0) return undefined;
  const prior = samples[priorIndex]!;
  const priorObject = prior.objects?.find((object) => object.id === id);
  const next = samples[priorIndex + 1];
  if (prior.tick === tick || next === undefined || priorObject === undefined) {
    return priorObject;
  }
  const nextObject = next.objects?.find((object) => object.id === id);
  if (nextObject === undefined || next.discontinuities?.includes(id)) return priorObject;
  const tickSpan = next.tick - prior.tick;
  if (tickSpan <= 0) return priorObject;
  if (isImplicitDiscontinuity(priorObject, nextObject, tickSpan, tickDurationMs)) {
    return priorObject;
  }
  const ratio = Math.max(0, Math.min(1, (tick - prior.tick) / tickSpan));
  if (ratio >= 1) return nextObject;
  const fromVelocity = priorObject.velocity ?? [0, 0];
  const toVelocity = nextObject.velocity ?? [0, 0];
  const durationSeconds = tickSpan * tickDurationMs / 1_000;
  return {
    id,
    position: [
      interpolateAxis(
        priorObject.position[0],
        nextObject.position[0],
        fromVelocity[0],
        toVelocity[0],
        ratio,
        durationSeconds,
      ),
      interpolateAxis(
        priorObject.position[1],
        nextObject.position[1],
        fromVelocity[1],
        toVelocity[1],
        ratio,
        durationSeconds,
      ),
    ],
    velocity: [
      interpolatedVelocity(
        priorObject.position[0], nextObject.position[0],
        fromVelocity[0], toVelocity[0], ratio, durationSeconds,
      ),
      interpolatedVelocity(
        priorObject.position[1], nextObject.position[1],
        fromVelocity[1], toVelocity[1], ratio, durationSeconds,
      ),
    ],
  };
};
