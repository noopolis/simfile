import { useEffect, useMemo, useRef } from "react";

import {
  jumpEnd,
  jumpStart,
  maxCursor,
  setCursor,
  setSpeed,
  stepBy,
  timelineStore,
  togglePlay,
  useTimelineStore,
  type TimelineEvent,
} from "../store/timeline.js";
import { currentClockReadout, derivePhaseBands, spreadDotEvents } from "./clockModel.js";
import {
  cursorAtElapsed,
  derivePlaybackCadence,
  playbackCadenceReadout,
  playbackTickAtCursor,
  playbackTickAtElapsed,
} from "./playbackCadence.js";

export interface ScrubBarProps {
  readonly firstTick?: number;
  readonly lastTick?: number;
  readonly onPresentationTickChange?: (tick: number | undefined) => void;
  readonly presentationTickAtCursor?: (cursor: number) => number | undefined;
  readonly seedSpreadEventIds?: ReadonlySet<string>;
  readonly tickDurationMs?: number;
}

interface PlaybackAnchor {
  readonly cursor: number;
  readonly presentationTick?: number;
  readonly timestampMs: number;
}

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

const formatClock = (recordedAt: string): string => {
  const date = new Date(recordedAt);
  if (Number.isNaN(date.getTime())) return recordedAt;
  return date.toISOString().slice(11, 23);
};

const readoutFor = (event: TimelineEvent | undefined, cursor: number, max: number): string => {
  if (!event) return `step ${cursor}/${max}`;
  return `step ${cursor}/${max} · ${formatClock(event.recordedAt)}`;
};

/** A stable-ish color per phase name, so adjacent bands read as distinct without hardcoding any specific phase's name (`morning`/`workday`/... are fixture-owned, not chrome-owned). */
const phaseBandTone = (phase: string, index: number): number => {
  let hash = index;
  for (let i = 0; i < phase.length; i += 1) hash = (hash * 31 + phase.charCodeAt(i)) % 5;
  return hash;
};

/**
 * The global scrub bar (`VIEW_DESIGN.md` rule 7: "the scrub bar is global
 * chrome"). One `<input type="range">` over `[0, N-1]` plus play/pause/step
 * controls, all driving the single `timelineStore` cursor every time-linked
 * view reads. Playback respects `prefers-reduced-motion`: when set, the
 * play button is disabled rather than silently ticking behind a user's
 * back.
 *
 * Increment 3: when the run has a world `clock.sync` stream, a row of
 * phase bands renders under the track (`derivePhaseBands`) and the readout
 * gains a `tick N · phase` prefix (`currentClockReadout`) — both derive
 * from real `clock.sync` payloads, so a run with no world stream simply
 * renders neither. `seedSpreadEventIds`, when
 * passed, marks the real `seed_spread` events on the track as distinct
 * "spread dots" (`spreadDotEvents`) — omitted (no dots) for a run with no
 * seed declaration.
 */
export function ScrubBar({
  firstTick,
  lastTick,
  onPresentationTickChange,
  presentationTickAtCursor,
  seedSpreadEventIds,
  tickDurationMs,
}: ScrubBarProps) {
  const { timeline, cursor, playing, speed } = useTimelineStore();
  const reducedMotion = useMemo(prefersReducedMotion, []);
  const animationFrameRef = useRef<number | null>(null);
  const anchorRef = useRef<PlaybackAnchor | null>(null);
  const lastWrittenCursorRef = useRef<number | null>(null);

  const max = maxCursor(timeline);
  const cadence = useMemo(
    () => derivePlaybackCadence({
      eventCount: timeline?.events.length ?? 0,
      events: timeline?.events,
      firstTick,
      lastTick,
      tickDurationMs,
      speed,
    }),
    [timeline, firstTick, lastTick, tickDurationMs, speed],
  );
  const currentEvent = timeline?.events[cursor];
  const phaseBands = useMemo(() => (timeline ? derivePhaseBands(timeline.events) : []), [timeline]);
  const clockReadout = useMemo(() => (timeline ? currentClockReadout(timeline.events, cursor) : undefined), [timeline, cursor]);
  const spreadDots = useMemo(
    () => (timeline && seedSpreadEventIds ? spreadDotEvents(timeline.events, seedSpreadEventIds) : []),
    [timeline, seedSpreadEventIds],
  );

  useEffect(() => {
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = null;
    anchorRef.current = null;
    lastWrittenCursorRef.current = null;
    if (!playing || reducedMotion || !timeline) return;

    const advance = (timestampMs: number): void => {
      animationFrameRef.current = null;
      const storeCursor = timelineStore.getSnapshot().cursor;
      let anchor = anchorRef.current;

      if (anchor === null || (lastWrittenCursorRef.current !== null && storeCursor !== lastWrittenCursorRef.current)) {
        anchor = {
          cursor: storeCursor,
          presentationTick: presentationTickAtCursor?.(storeCursor),
          timestampMs,
        };
        anchorRef.current = anchor;
      }

      const nextCursor = cursorAtElapsed(anchor.cursor, timestampMs - anchor.timestampMs, cadence, max);
      onPresentationTickChange?.(
        playbackTickAtElapsed(
          anchor.cursor,
          timestampMs - anchor.timestampMs,
          cadence,
          anchor.presentationTick,
          lastTick,
        ),
      );
      if (nextCursor !== lastWrittenCursorRef.current) {
        setCursor(nextCursor);
        lastWrittenCursorRef.current = nextCursor;
      }

      if (nextCursor >= max) {
        anchorRef.current = null;
        lastWrittenCursorRef.current = null;
        togglePlay();
        return;
      }

      animationFrameRef.current = requestAnimationFrame(advance);
    };

    animationFrameRef.current = requestAnimationFrame(advance);

    return () => {
      if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
      anchorRef.current = null;
      lastWrittenCursorRef.current = null;
    };
  }, [
    playing,
    reducedMotion,
    timeline,
    max,
    cadence,
    lastTick,
    onPresentationTickChange,
    presentationTickAtCursor,
  ]);

  useEffect(() => {
    if (!playing) {
      onPresentationTickChange?.(
        presentationTickAtCursor?.(cursor) ?? playbackTickAtCursor(cadence, cursor),
      );
    }
  }, [playing, cursor, cadence, onPresentationTickChange, presentationTickAtCursor]);

  if (!timeline) {
    return (
      <footer className="scrub-bar scrub-bar-empty">
        <span>loading run timeline…</span>
      </footer>
    );
  }

  const densityTicks = timeline.events.filter((_, index) => index % Math.max(1, Math.floor(max / 120) || 1) === 0);
  const cadenceReadout = playbackCadenceReadout(cadence);

  return (
    <footer className="scrub-bar">
      <div className="scrub-controls">
        <button aria-label="Jump to start" onClick={jumpStart} type="button">|&lt;</button>
        <button aria-label="Step back" onClick={() => stepBy(-1)} type="button">&lt;</button>
        <button
          aria-label={playing ? "Pause" : "Play"}
          className={playing ? "active" : ""}
          disabled={reducedMotion}
          onClick={togglePlay}
          title={reducedMotion ? "Playback disabled: prefers-reduced-motion is set" : undefined}
          type="button"
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <button aria-label="Step forward" onClick={() => stepBy(1)} type="button">&gt;</button>
        <button aria-label="Jump to end" onClick={jumpEnd} type="button">&gt;|</button>
        <label className="scrub-speed">
          <span>speed</span>
          <select
            aria-label="Playback speed"
            onChange={(event) => setSpeed(Number(event.target.value))}
            value={speed}
          >
            {[0.5, 1, 2, 4, 8].map((option) => (
              <option key={option} value={option}>{option}x</option>
            ))}
          </select>
        </label>
      </div>

      <div className="scrub-track-wrap">
        {phaseBands.length > 0 ? (
          <div className="scrub-phase-bands" aria-hidden="true">
            {phaseBands.map((band, index) => {
              const left = max === 0 ? 0 : (band.t0 / max) * 100;
              const right = max === 0 ? 100 : (Math.min(band.t1, max) / max) * 100;
              return (
                <span
                  className={`scrub-phase-band tone-${phaseBandTone(band.phase, index)}`}
                  key={`${band.t0}-${band.phase}`}
                  style={{ left: `${left}%`, width: `${Math.max(0, right - left)}%` }}
                  title={`tick ${band.tick} · ${band.phase}`}
                />
              );
            })}
          </div>
        ) : null}
        <div className="scrub-density" aria-hidden="true">
          {densityTicks.map((event) => (
            <span key={event.eventId} style={{ left: `${max === 0 ? 0 : (event.t / max) * 100}%` }} />
          ))}
        </div>
        {spreadDots.length > 0 ? (
          <div className="scrub-spread-dots" aria-hidden="true">
            {spreadDots.map((event) => (
              <span
                className="scrub-spread-dot"
                key={event.eventId}
                style={{ left: `${max === 0 ? 0 : (event.t / max) * 100}%` }}
                title={`seed spread · ${event.actor ?? event.authority} · ${event.type}`}
              />
            ))}
          </div>
        ) : null}
        <input
          aria-label="Scrub position"
          max={max}
          min={0}
          onChange={(event) => setCursor(Number(event.target.value))}
          step={1}
          type="range"
          value={cursor}
        />
      </div>

      <div className="scrub-readout">
        {clockReadout ? <span className="scrub-tick">tick {clockReadout.tick} · {clockReadout.phase} · </span> : null}
        {readoutFor(currentEvent, cursor, max)}
        {" · "}<span className="scrub-cadence">{cadenceReadout}</span>
      </div>
    </footer>
  );
}
