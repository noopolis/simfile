import { useEffect, useMemo, useRef } from "react";

import {
  jumpEnd,
  jumpStart,
  maxCursor,
  setCursor,
  setSpeed,
  stepBy,
  togglePlay,
  useTimelineStore,
  type TimelineEvent,
} from "../store/timeline.js";

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

const formatClock = (recordedAt: string): string => {
  const date = new Date(recordedAt);
  if (Number.isNaN(date.getTime())) return recordedAt;
  return date.toISOString().slice(11, 23);
};

const readoutFor = (event: TimelineEvent | undefined, cursor: number, max: number): string => {
  if (!event) return `step ${cursor}/${max}`;
  return `step ${cursor}/${max} · ${formatClock(event.recordedAt)} · ${event.authority}:${event.streamId}:${event.viewClass}`;
};

/**
 * The global scrub bar (`VIEW_DESIGN.md` rule 7: "the scrub bar is global
 * chrome"). One `<input type="range">` over `[0, N-1]` plus play/pause/step
 * controls, all driving the single `timelineStore` cursor every time-linked
 * view reads. Playback respects `prefers-reduced-motion`: when set, the
 * play button is disabled rather than silently ticking behind a user's
 * back.
 */
export function ScrubBar() {
  const { timeline, cursor, playing, speed } = useTimelineStore();
  const reducedMotion = useMemo(prefersReducedMotion, []);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Read the latest cursor inside the interval without re-creating it every tick.
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  const max = maxCursor(timeline);
  const currentEvent = timeline?.events[cursor];

  useEffect(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (!playing || reducedMotion || !timeline) return;

    timerRef.current = setInterval(() => {
      const nextCursor = cursorRef.current + 1;
      if (nextCursor > max) {
        togglePlay();
        return;
      }
      setCursor(nextCursor);
    }, Math.max(50, 1000 / speed));

    return () => {
      if (timerRef.current !== null) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed, reducedMotion, timeline, max]);

  if (!timeline) {
    return (
      <footer className="scrub-bar scrub-bar-empty">
        <span>loading run timeline…</span>
      </footer>
    );
  }

  const densityTicks = timeline.events.filter((_, index) => index % Math.max(1, Math.floor(max / 120) || 1) === 0);

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
        <div className="scrub-density" aria-hidden="true">
          {densityTicks.map((event) => (
            <span key={event.eventId} style={{ left: `${max === 0 ? 0 : (event.t / max) * 100}%` }} />
          ))}
        </div>
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

      <div className="scrub-readout">{readoutFor(currentEvent, cursor, max)}</div>
    </footer>
  );
}
