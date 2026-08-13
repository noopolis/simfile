import type { ViewerSpatialSample } from "./types.js";

export const spatialPlaybackSpeeds = [0.25, 0.5, 1, 2] as const;
export type SpatialPlaybackSpeed = typeof spatialPlaybackSpeeds[number];
export const liveSpatialPlaybackDelayMs = 1_000;
const maximumPresentationStepMs = 100;

export interface SpatialPlaybackState {
  readonly ended: boolean;
  readonly frame: number;
  readonly playing: boolean;
  readonly tick: number;
}

export interface SpatialPlaybackAnimationClock {
  readonly anchorTick: number | null;
  readonly priorTimestampMs: number | null;
  readonly startedAtMs: number | null;
}

export interface SpatialPlaybackAnimationStep {
  readonly clock: SpatialPlaybackAnimationClock;
  readonly elapsedMs: number;
  readonly playback: SpatialPlaybackState;
}

export const createSpatialPlaybackAnimationClock = (): SpatialPlaybackAnimationClock =>
  Object.freeze({
    anchorTick: null,
    priorTimestampMs: null,
    startedAtMs: null,
  });

/**
 * Converts requestAnimationFrame timestamps to one exact wall-time delta.
 * Sparse authoritative samples never participate in clock rate.
 */
export const stepSpatialPlaybackAnimationClock = (
  clock: SpatialPlaybackAnimationClock,
  playback: SpatialPlaybackState,
  samples: readonly ViewerSpatialSample[],
  timestampMs: number,
  tickDurationMs: number,
  speed: SpatialPlaybackSpeed,
): SpatialPlaybackAnimationStep => {
  const startedAtMs = clock.startedAtMs ?? timestampMs;
  const anchorTick = clock.anchorTick ?? playback.tick;
  const elapsedMs = clock.priorTimestampMs === null
    ? 0
    : Math.max(0, timestampMs - clock.priorTimestampMs);
  const totalElapsedMs = Math.max(0, timestampMs - startedAtMs);
  const anchoredPlayback = Object.freeze({
    ...playback,
    ended: false,
    playing: true,
    tick: anchorTick,
  });
  return Object.freeze({
    clock: Object.freeze({
      anchorTick,
      priorTimestampMs: timestampMs,
      startedAtMs,
    }),
    elapsedMs,
    playback: advanceSpatialPlayback(
      anchoredPlayback,
      samples,
      totalElapsedMs,
      tickDurationMs,
      speed,
    ),
  });
};

export const clampSpatialFrame = (frame: number, length: number): number =>
  Math.max(0, Math.min(Math.max(0, length - 1), Math.trunc(frame)));

const frameAtOrBeforeTick = (
  samples: readonly ViewerSpatialSample[],
  tick: number,
): number => {
  let frame = 0;
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index]!.tick > tick) break;
    frame = index;
  }
  return frame;
};

const liveDelayTicks = (tickDurationMs: number): number =>
  Math.max(1, Math.ceil(liveSpatialPlaybackDelayMs / tickDurationMs));

const liveTargetTick = (
  samples: readonly ViewerSpatialSample[],
  tickDurationMs: number,
): number => {
  const firstTick = samples[0]?.tick ?? 0;
  const frontierTick = samples.at(-1)?.tick ?? firstTick;
  return Math.max(firstTick, frontierTick - liveDelayTicks(tickDurationMs));
};

const liveBufferReady = (
  samples: readonly ViewerSpatialSample[],
  tickDurationMs: number,
): boolean =>
  samples.length > 1
  && samples.at(-1)!.tick - samples[0]!.tick >= liveDelayTicks(tickDurationMs);

export const createSpatialPlaybackState = (
  samples: readonly ViewerSpatialSample[],
  playing = false,
): SpatialPlaybackState => {
  const tick = samples[0]?.tick ?? 0;
  return Object.freeze({
    ended: samples.length < 2,
    frame: 0,
    playing: playing && samples.length > 1,
    tick,
  });
};

/**
 * Starts a live clock behind the authoritative frontier. The deliberate delay
 * leaves future samples available for presentation-only interpolation.
 */
export const createLiveSpatialPlaybackState = (
  samples: readonly ViewerSpatialSample[],
  tickDurationMs: number,
  reducedMotion = false,
): SpatialPlaybackState => {
  const tick = liveTargetTick(samples, tickDurationMs);
  const ready = liveBufferReady(samples, tickDurationMs);
  return Object.freeze({
    ended: false,
    frame: frameAtOrBeforeTick(samples, tick),
    playing: ready && !reducedMotion,
    tick,
  });
};

/**
 * Reconciles an appended live frontier without extrapolating past the jitter
 * buffer. A very stale background tab is corrected only after it exceeds two
 * full buffer windows.
 */
export const reconcileLiveSpatialPlayback = (
  state: SpatialPlaybackState,
  samples: readonly ViewerSpatialSample[],
  tickDurationMs: number,
  reducedMotion = false,
): SpatialPlaybackState => {
  if (samples.length === 0) return createLiveSpatialPlaybackState(samples, tickDurationMs, reducedMotion);
  const firstTick = samples[0]!.tick;
  const targetTick = liveTargetTick(samples, tickDurationMs);
  const maximumLagTicks = liveDelayTicks(tickDurationMs) * 2;
  const tick = reducedMotion || state.tick < firstTick
    || targetTick - state.tick > maximumLagTicks
    ? targetTick
    : Math.min(state.tick, targetTick);
  return Object.freeze({
    ended: false,
    frame: frameAtOrBeforeTick(samples, tick),
    playing: liveBufferReady(samples, tickDurationMs) && !reducedMotion,
    tick,
  });
};

export const scrubSpatialPlayback = (
  samples: readonly ViewerSpatialSample[],
  frame: number,
): SpatialPlaybackState => {
  const nextFrame = clampSpatialFrame(frame, samples.length);
  return Object.freeze({
    ended: samples.length < 2 || nextFrame >= samples.length - 1,
    frame: nextFrame,
    playing: false,
    tick: samples[nextFrame]?.tick ?? 0,
  });
};

export const setSpatialPlaybackPlaying = (
  state: SpatialPlaybackState,
  samples: readonly ViewerSpatialSample[],
  playing: boolean,
): SpatialPlaybackState => {
  if (!playing || samples.length < 2) {
    return Object.freeze({ ...state, playing: false });
  }
  if (state.ended) {
    return createSpatialPlaybackState(samples, true);
  }
  return Object.freeze({ ...state, playing: true });
};

/**
 * Rebinds a DVR playhead to an appended authoritative sample set without
 * moving its simulated-time cursor. The caller owns explicit play intent.
 */
export const reconcileSpatialPlaybackSamples = (
  state: SpatialPlaybackState,
  samples: readonly ViewerSpatialSample[],
  playRequested: boolean,
): SpatialPlaybackState => {
  if (samples.length === 0) return createSpatialPlaybackState(samples);
  const firstTick = samples[0]!.tick;
  const finalTick = samples.at(-1)!.tick;
  const tick = Math.max(firstTick, Math.min(finalTick, state.tick));
  const ended = samples.length < 2 || tick >= finalTick;
  return Object.freeze({
    ended,
    frame: frameAtOrBeforeTick(samples, tick),
    playing: playRequested && !ended,
    tick,
  });
};

export const advanceSpatialPlayback = (
  state: SpatialPlaybackState,
  samples: readonly ViewerSpatialSample[],
  elapsedMs: number,
  tickDurationMs: number,
  speed: SpatialPlaybackSpeed,
): SpatialPlaybackState => {
  if (!state.playing || samples.length < 2 || !Number.isFinite(elapsedMs)
    || elapsedMs <= 0 || !Number.isFinite(tickDurationMs) || tickDurationMs <= 0) {
    return state;
  }
  const finalTick = samples.at(-1)!.tick;
  const tick = Math.min(finalTick, state.tick + elapsedMs * speed / tickDurationMs);
  const ended = tick >= finalTick;
  return Object.freeze({
    ended,
    frame: frameAtOrBeforeTick(samples, tick),
    playing: !ended,
    tick,
  });
};

/**
 * Advances at exact simulated-time pace on animation frames and holds at the
 * delayed authoritative frontier. Long suspended-frame deltas are capped; the
 * reconcile path performs the separate bounded stale-tab correction.
 */
export const advanceLiveSpatialPlayback = (
  state: SpatialPlaybackState,
  samples: readonly ViewerSpatialSample[],
  elapsedMs: number,
  tickDurationMs: number,
  drain = false,
): SpatialPlaybackState => {
  if (!state.playing || samples.length < 2 || !Number.isFinite(elapsedMs)
    || elapsedMs <= 0 || !Number.isFinite(tickDurationMs) || tickDurationMs <= 0) {
    return state;
  }
  const targetTick = drain
    ? samples.at(-1)!.tick
    : liveTargetTick(samples, tickDurationMs);
  const tick = Math.min(
    targetTick,
    state.tick + Math.min(elapsedMs, maximumPresentationStepMs) / tickDurationMs,
  );
  if (tick === state.tick) return state;
  return Object.freeze({
    ended: false,
    frame: frameAtOrBeforeTick(samples, tick),
    playing: true,
    tick,
  });
};
