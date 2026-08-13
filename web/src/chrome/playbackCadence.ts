/**
 * Playback keeps the cursor event-indexed because every pane already uses it
 * as its key: ChatPane and MindsRail consume the `t <= cursor` prefix,
 * clockModel bands are expressed in `t`, deep links persist a cursor, and
 * `maxCursor(timeline)` is `events.length - 1`. Re-indexing by tick would
 * change stored deep-link meaning, collapse distinct event positions, and
 * remove the ability to step to one event; in the measured run it would
 * collapse 18,002 cursor positions to 2,001 ticks.
 *
 * Instead, wall time advances simulated time at the trace's declared tick
 * rate, and simulated time selects the cursor. Event-index movement is
 * therefore intentionally non-uniform when event density is non-uniform.
 * Each event's simulated time comes from its own real `recordedAt` value,
 * never an invented ratio, and is trusted only when the final timestamp
 * corroborates the trace's declared tick span.
 */

interface SimulatedTimeIndex {
  readonly derivedTicks: readonly number[];
  readonly speed: number;
  readonly tickDurationMs: number;
}

export interface PlaybackCadence {
  /** Store-cursor steps per real second at the caller's speed. Always finite and > 0. */
  readonly cursorsPerSecond: number;
  /** True when the trace supplied a usable tick duration and tick span. */
  readonly declaredTiming: boolean;
  /** Real milliseconds for a full pass from cursor 0 to the last event. */
  readonly realDurationMs: number;
  /** True when declared timing set the rate; false when the presentation floor won or timing is absent. */
  readonly realTime: boolean;
  /** Sanitized playback multiplier used by the presentation clock. */
  readonly speed: number;
  /** Positive declared tick duration when the trace supplies one. */
  readonly tickDurationMs?: number;
  /** @internal Accepted event timestamps expressed as simulated ticks. */
  readonly simulatedTimeIndex?: SimulatedTimeIndex;
}

export interface PlaybackCadenceInput {
  readonly eventCount: number;
  /** First/last tick of the trace's own spatial samples, when it has them. */
  readonly firstTick?: number;
  readonly lastTick?: number;
  /** The trace's DECLARED `tick_duration_ms`. Undefined when the trace declares none. */
  readonly tickDurationMs?: number;
  readonly speed: number;
  /** The trace's own events, in cursor order, for their recorded simulated timestamps. Optional: absent = the pre-existing event-uniform pacing. */
  readonly events?: readonly {
    readonly payload?: unknown;
    readonly recordedAt: string;
    readonly type?: string;
  }[];
}

const spatialSampleTicks = (
  events: readonly { readonly payload?: unknown; readonly type?: string }[],
  firstTick: number,
  lastTick: number,
): readonly number[] | undefined => {
  const ticks = events.map((event) => {
    if (event.type !== "spatial.sample" || typeof event.payload !== "object"
      || event.payload === null || Array.isArray(event.payload)) return undefined;
    const tick = (event.payload as { tick?: unknown }).tick;
    return typeof tick === "number" && Number.isFinite(tick) ? tick : undefined;
  });
  if (ticks.some((tick) => tick === undefined)) return undefined;
  const values = ticks as number[];
  if (values[0] !== firstTick || values.at(-1) !== lastTick
    || values.some((tick, index) => index > 0 && tick < values[index - 1]!)) {
    return undefined;
  }
  return values;
};

const deriveSimulatedTimeIndex = (
  events: readonly {
    readonly payload?: unknown;
    readonly recordedAt: string;
    readonly type?: string;
  }[],
  eventCount: number,
  firstTick: number,
  lastTick: number,
  tickDurationMs: number,
  speed: number,
  explicitSpatialTicks?: readonly number[],
): SimulatedTimeIndex | undefined => {
  if (events.length === 0 || events.length !== eventCount) return undefined;

  if (explicitSpatialTicks !== undefined) {
    return { derivedTicks: explicitSpatialTicks, speed, tickDurationMs };
  }

  const recordedAtMs = events.map((event) => Date.parse(event.recordedAt));
  if (recordedAtMs.some((value) => !Number.isFinite(value))) return undefined;
  for (let index = 1; index < recordedAtMs.length; index += 1) {
    if (recordedAtMs[index]! < recordedAtMs[index - 1]!) return undefined;
  }

  const originMs = recordedAtMs[0]!;
  const derivedTicks = recordedAtMs.map(
    (value) => firstTick + (value - originMs) / tickDurationMs,
  );
  const derivedLastTick = derivedTicks[derivedTicks.length - 1]!;
  if (Math.abs(derivedLastTick - lastTick) > 1) return undefined;

  return { derivedTicks, speed, tickDurationMs };
};

/**
 * Derives discrete replay-cursor pacing from the trace's declared simulated
 * duration. One cursor per second is a presentation minimum for human
 * watchability: advancing once per simulated minute or hour would leave the
 * viewer showing no change for too long. The floor is not an assumption about
 * any trace's tick scale.
 *
 * When a trace's declared tick is shorter than one animation frame, and more
 * so at higher playback speeds, the choice is multi-step-per-frame advancement
 * or interpolation. We deliberately advance multiple steps. The scrub cursor
 * is a discrete "as of" selector over an event list, so there is no partial
 * state between cursor 7 and cursor 8 for this layer to interpolate. Computing
 * each frame's cursor directly from wall time makes a high step rate one store
 * write per frame instead of a proportional catch-up loop. The corroborated
 * timestamp path finds the cursor in O(log n); the event-uniform fallback is
 * O(1). Events are not dropped because panes consume the complete `t <=
 * cursor` prefix, not only the latest event. Continuous interpolation is
 * intentionally delegated to the better-informed layer below:
 * `../viewer/spatialObjectModel.ts`'s `spatialObjectAtPresentationTick`
 * interpolates rendered position between authoritative samples, using each
 * sample's recorded velocity as a Hermite tangent. This module answers only
 * "what has happened by now?".
 */
export const derivePlaybackCadence = (input: PlaybackCadenceInput): PlaybackCadence => {
  const { eventCount, events, firstTick, lastTick, tickDurationMs } = input;
  let baseCursorsPerSecond = 1;
  let realTimeCursorsPerSecond = 0;
  let realTime = false;
  const declaredTiming = (
    Number.isFinite(tickDurationMs)
    && tickDurationMs !== undefined
    && tickDurationMs > 0
    && Number.isFinite(firstTick)
    && firstTick !== undefined
    && Number.isFinite(lastTick)
    && lastTick !== undefined
    && lastTick - firstTick >= 1
  );

  if (declaredTiming && eventCount >= 2) {
    const simulatedDurationMs = (lastTick - firstTick) * tickDurationMs;
    realTimeCursorsPerSecond = (eventCount - 1) / (simulatedDurationMs / 1_000);
    const finiteRealTimeRate = Number.isFinite(realTimeCursorsPerSecond)
      ? realTimeCursorsPerSecond
      : realTimeCursorsPerSecond > 0
        ? Number.MAX_VALUE
        : 0;
    baseCursorsPerSecond = Math.max(1, finiteRealTimeRate);
    realTime = realTimeCursorsPerSecond >= 1;
  }

  const speed = Number.isFinite(input.speed) && input.speed > 0 ? input.speed : 1;
  const multipliedRate = baseCursorsPerSecond * speed;
  const cursorsPerSecond = Number.isFinite(multipliedRate) && multipliedRate > 0
    ? multipliedRate
    : Number.MAX_VALUE;
  const explicitSpatialTicks = (
    declaredTiming
    && events !== undefined
    && firstTick !== undefined
    && lastTick !== undefined
  )
    ? spatialSampleTicks(events, firstTick, lastTick)
    : undefined;
  // Sparse spatial samples can fall below the one-cursor-per-second
  // watchability floor. Scale their simulated clock by the same factor as
  // the cursor rate so the map and scrubber still arrive together.
  const indexSpeed = explicitSpatialTicks !== undefined
    && Number.isFinite(realTimeCursorsPerSecond)
    && realTimeCursorsPerSecond > 0
    ? speed * baseCursorsPerSecond / realTimeCursorsPerSecond
    : speed;
  const simulatedTimeIndex = (
    declaredTiming
    && (realTime || explicitSpatialTicks !== undefined)
    && events !== undefined
    && firstTick !== undefined
    && lastTick !== undefined
    && tickDurationMs !== undefined
  )
    ? deriveSimulatedTimeIndex(
      events,
      eventCount,
      firstTick,
      lastTick,
      tickDurationMs,
      indexSpeed,
      explicitSpatialTicks,
    )
    : undefined;

  return {
    cursorsPerSecond,
    declaredTiming,
    realDurationMs: Math.max(0, eventCount - 1) / cursorsPerSecond * 1_000,
    realTime,
    speed,
    tickDurationMs: declaredTiming ? tickDurationMs : undefined,
    simulatedTimeIndex,
  };
};

export const playbackCadenceReadout = (cadence: PlaybackCadence): string => {
  const roundedCadence = cadence.cursorsPerSecond >= 10
    ? String(Math.round(cadence.cursorsPerSecond))
    : cadence.cursorsPerSecond.toFixed(1);

  if (!cadence.declaredTiming) return `${roundedCadence} steps/s`;
  return cadence.realTime
    ? `${roundedCadence} steps/s · real time`
    : `${roundedCadence} steps/s · faster than real time`;
};

const continuousPlaybackTickAtCursor = (
  cadence: PlaybackCadence,
  cursor: number,
): number | undefined => {
  const index = cadence.simulatedTimeIndex;
  if (!index) return undefined;
  const wholeCursor = Number.isNaN(cursor) ? 0 : Math.floor(cursor);
  const clampedCursor = wholeCursor <= 0
    ? 0
    : wholeCursor >= index.derivedTicks.length - 1
      ? index.derivedTicks.length - 1
      : wholeCursor;
  return index.derivedTicks[clampedCursor];
};

export const cursorAtElapsed = (
  anchorCursor: number,
  elapsedMs: number,
  cadence: PlaybackCadence,
  maxCursor: number,
): number => {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return anchorCursor;
  const index = cadence.simulatedTimeIndex;
  if (index) {
    const anchorTick = continuousPlaybackTickAtCursor(cadence, anchorCursor)!;
    const targetTick = anchorTick + elapsedMs * index.speed / index.tickDurationMs;
    let low = 0;
    let high = index.derivedTicks.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (index.derivedTicks[middle]! <= targetTick) low = middle + 1;
      else high = middle;
    }
    const elapsedCursor = low - 1;
    return Math.max(anchorCursor, Math.min(maxCursor, elapsedCursor));
  }
  const elapsedCursor = anchorCursor + Math.floor(elapsedMs * cadence.cursorsPerSecond / 1_000);
  return Math.max(anchorCursor, Math.min(maxCursor, elapsedCursor));
};

/**
 * The app's single owner of the `cursor -> tick` mapping. When the trace has a
 * corroborated clock, returns the whole simulated world tick where the
 * record's own clock places the selected event: cursor 0 is the first event's
 * tick and the final cursor is the final event's tick. Rounding removes only
 * the fractional tick introduced when the ledger's ISO timestamp truncates
 * simulated time to whole milliseconds; a discrete event cursor contains no
 * sub-tick position to preserve. Consumers must not reimplement this join.
 */
export const playbackTickAtCursor = (
  cadence: PlaybackCadence,
  cursor: number,
): number | undefined => {
  const continuousTick = continuousPlaybackTickAtCursor(cadence, cursor);
  return continuousTick === undefined ? undefined : Math.round(continuousTick);
};

/**
 * Advances the presentation clock continuously between recorded events.
 * Event panes remain cursor-indexed; spatial renderers can use this value on
 * each animation frame so their existing interpolation is not frozen while
 * the event cursor waits for the next record.
 */
export const playbackTickAtElapsed = (
  anchorCursor: number,
  elapsedMs: number,
  cadence: PlaybackCadence,
  recordedAnchorTick?: number,
  lastTick?: number,
): number | undefined => {
  const index = cadence.simulatedTimeIndex;
  const anchorTick = index
    ? continuousPlaybackTickAtCursor(cadence, anchorCursor)!
    : recordedAnchorTick;
  const tickDurationMs = index?.tickDurationMs ?? cadence.tickDurationMs;
  const speed = index?.speed ?? cadence.speed;
  if (anchorTick === undefined || tickDurationMs === undefined) return undefined;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return anchorTick;
  const maximum = index?.derivedTicks[index.derivedTicks.length - 1] ?? lastTick;
  const tick = anchorTick + elapsedMs * speed / tickDurationMs;
  return maximum === undefined ? tick : Math.min(maximum, tick);
};
