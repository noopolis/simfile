import type { TimelineEvent } from "../store/timeline.js";

/**
 * Increment 3: pure derivations over the world's `clock.sync` stream
 * (`viewClass === "clock"`, `runTimeline.ts`'s `buildWorldRecord`) and the
 * seed-spread event set, both consumed by `ScrubBar.tsx` — kept here,
 * outside the component, so they're unit-testable without rendering React
 * (this repo's test runner only picks up `.test.ts`, never `.test.tsx`).
 * A run with no world stream (e.g. `office-sim-golden`) simply has no
 * `viewClass === "clock"` events, so every function here degrades to its
 * empty/undefined case rather than needing a special "no world" branch.
 */

interface ClockPayload {
  tick?: number;
  phase?: string;
  sim_time?: number;
}

const clockPayload = (event: TimelineEvent): ClockPayload =>
  event.payload && typeof event.payload === "object" ? (event.payload as ClockPayload) : {};

export interface PhaseBand {
  /** Scrub-key range this band covers, inclusive. `t1` may exceed the timeline's max `t` — callers clamp against their own `max`. */
  t0: number;
  t1: number;
  tick: number;
  phase: string;
}

/**
 * One band per `clock.sync` event, in `t` order, each running until the
 * next tick's own `t - 1` (the last band runs to `Number.MAX_SAFE_INTEGER`
 * — callers clamp against the scrub bar's own `max`). Phase/tick values are
 * read verbatim from each event's own payload, never invented.
 */
export const derivePhaseBands = (events: readonly TimelineEvent[]): PhaseBand[] => {
  const clockEvents = events.filter((event) => event.viewClass === "clock").slice().sort((left, right) => left.t - right.t);
  return clockEvents.map((event, index) => {
    const payload = clockPayload(event);
    const next = clockEvents[index + 1];
    return {
      t0: event.t,
      t1: next ? next.t - 1 : Number.MAX_SAFE_INTEGER,
      tick: payload.tick ?? index,
      phase: payload.phase ?? "unknown",
    };
  });
};

export interface ClockReadout {
  tick: number;
  phase: string;
  simTime?: number;
}

/**
 * The latest `clock.sync` at-or-before `cursor` — the scrub bar's tick/phase
 * readout. `undefined` when the run has no world clock stream at all, or
 * the cursor sits before the first tick.
 */
export const currentClockReadout = (events: readonly TimelineEvent[], cursor: number): ClockReadout | undefined => {
  const clockEvents = events.filter((event) => event.viewClass === "clock" && event.t <= cursor);
  const last = clockEvents[clockEvents.length - 1];
  if (!last) return undefined;
  const payload = clockPayload(last);
  return { tick: payload.tick ?? 0, phase: payload.phase ?? "unknown", simTime: payload.sim_time };
};

/** The real `TimelineEvent` rows to mark as scrub-bar "spread dots" — every seed_spread event id that actually joins to a recorded event in this run. */
export const spreadDotEvents = (events: readonly TimelineEvent[], eventIds: ReadonlySet<string>): TimelineEvent[] =>
  events.filter((event) => eventIds.has(event.eventId));
