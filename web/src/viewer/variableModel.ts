import { playbackTickAtCursor, type PlaybackCadence } from "../chrome/playbackCadence.js";
import type { RunTimeline, TimelineEvent } from "../store/timeline.js";

/** One `world/telemetry.json` sample row — mirrors `src/view/runViewModelTypes.ts`'s `RunTelemetrySample`. The source of truth for this shape; `RunMetaPanels.tsx`'s `RunMeta` imports it from here rather than the reverse, so this module has no dependency back onto the component file. */
export interface RunMetaVariableSample {
  tick: number;
  simTime: number;
  phase?: string;
  variables: Record<string, number>;
}

/**
 * Increment 4's variable gauge/storyline join: pure functions over
 * `/api/run-meta`'s `variableSamples` (`world/telemetry.json`'s per-tick
 * samples, `src/view/runViewModelTypes.ts`'s `RunTelemetrySample`) and the
 * loaded `RunTimeline`'s explicitly recorded tick fields. Kept separate from
 * `../store/timeline.ts` for the same reason `spreadModel.ts` is: these
 * types belong to the run-meta contract, not the timeline contract. No UI
 * here — `RunMetaPanels.tsx`'s `VariableGaugeRail` and
 * `../portals/StorylinePortal.tsx`'s variable-ref branch both call these
 * rather than re-deriving the tick/sample joins inline.
 */

const asPayloadRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const recordedNumber = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined;

/** The tick a single event's payload explicitly records, with no derivation. */
export const recordedTickOf = (event: TimelineEvent): number | undefined => {
  const payload = asPayloadRecord(event.payload);
  if (!payload) return undefined;

  if (event.type === "clock.sync") return recordedNumber(payload.tick);
  if (event.type === "spatial.sample") return recordedNumber(payload.tick);
  if (event.type === "dynamics.step") return recordedNumber(payload.from_tick);
  if (event.type === "dynamics.action.applied" || event.type === "dynamics.action.rejected_by_mechanics") {
    return recordedNumber(payload.apply_tick);
  }
  if (event.type === "dynamics.action.queued" || event.type === "dynamics.action.rejected_at_ingress") {
    const receipt = asPayloadRecord(payload.receipt);
    const attempt = asPayloadRecord(payload.attempt);
    return recordedNumber(receipt?.apply_tick) ?? recordedNumber(attempt?.at_tick);
  }
  return undefined;
};

/**
 * Fallback for records with no corroborated clock: the latest tick explicitly
 * recorded at or before the cursor. This is never a rival cursor mapping and
 * must never be called from a component; components use `tickAtCursor`.
 */
export const recordedTickAtCursor = (
  timeline: RunTimeline,
  cursor: number,
): number | undefined => {
  let bestT = Number.NEGATIVE_INFINITY;
  let bestTick: number | undefined;
  for (const event of timeline.events) {
    if (event.t > cursor || event.t <= bestT) continue;
    const tick = recordedTickOf(event);
    if (tick !== undefined) {
      bestT = event.t;
      bestTick = tick;
    }
  }
  return bestTick;
};

/**
 * The cursor mapping lives in `../chrome/playbackCadence.ts`; delegation has
 * landed here as the one consumer-side accessor. Never add a second mapping
 * body here. The recorded scan is only a fallback when the owner cannot serve
 * a record because it has no corroborated clock.
 */
export const tickAtCursor = (
  timeline: RunTimeline,
  cursor: number,
  cadence?: PlaybackCadence,
): number | undefined => {
  const playbackTick = cadence === undefined
    ? undefined
    : playbackTickAtCursor(cadence, cursor);
  return playbackTick !== undefined
    ? playbackTick
    : recordedTickAtCursor(timeline, cursor);
};

/**
 * The variable sample "as of" a world tick: the last sample whose own
 * `tick` is `<= tick` (never a future sample — rule 7's "as of cursor"
 * invariant, applied to telemetry samples instead of timeline events).
 * `undefined` when there is no such sample (empty/undefined `samples`, or
 * `tick` is `undefined`).
 */
export const sampleAtTick = (
  samples: readonly RunMetaVariableSample[] | undefined,
  tick: number | undefined,
): RunMetaVariableSample | undefined => {
  if (!samples || tick === undefined) return undefined;
  let best: RunMetaVariableSample | undefined;
  for (const sample of samples) {
    if (sample.tick <= tick && (!best || sample.tick > best.tick)) best = sample;
  }
  return best;
};

/**
 * One variable's trajectory up to and including a world tick — the
 * sparkline series. Never includes a sample past `tick` (rule 7): a
 * variable's gauge/sparkline always reads "as of cursor," identical to
 * every other time-linked view in this app.
 */
export const trajectoryUpToTick = (
  samples: readonly RunMetaVariableSample[] | undefined,
  variableId: string,
  tick: number | undefined,
): number[] => {
  if (!samples || tick === undefined) return [];
  return samples
    .filter((sample) => sample.tick <= tick && sample.variables[variableId] !== undefined)
    .sort((left, right) => left.tick - right.tick)
    .map((sample) => sample.variables[variableId]!);
};
