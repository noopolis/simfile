import type { RunTimeline } from "../store/timeline.js";

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
 * loaded `RunTimeline`'s `clock.sync` events. Kept separate from
 * `../store/timeline.ts` for the same reason `spreadModel.ts` is: these
 * types belong to the run-meta contract, not the timeline contract. No UI
 * here — `RunMetaPanels.tsx`'s `VariableGaugeRail` and
 * `../portals/StorylinePortal.tsx`'s variable-ref branch both call these
 * rather than re-deriving the tick/sample joins inline.
 */

/**
 * The world clock's own tick "as of" a scrub cursor: the largest
 * `clock.sync` event's own `payload.tick` at or before `cursor` — never a
 * derived/invented tick. `undefined` for a run with no world stream at all
 * (graceful absence: `office-sim-golden`/`office-secret-v0-golden` render no
 * gauge regardless, since they also have no non-empty `variableSamples`).
 */
export const tickAtCursor = (timeline: RunTimeline, cursor: number): number | undefined => {
  let bestT = -1;
  let bestTick: number | undefined;
  for (const event of timeline.events) {
    if (event.type !== "clock.sync" || event.t > cursor || event.t <= bestT) continue;
    const tick = (event.payload as { tick?: unknown } | undefined)?.tick;
    if (typeof tick === "number") {
      bestT = event.t;
      bestTick = tick;
    }
  }
  return bestTick;
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
