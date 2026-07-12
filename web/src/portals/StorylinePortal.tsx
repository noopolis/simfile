import { useMemo } from "react";

import { eventsForElement, setCursor, setSelection, useTimelineStore, type ElementRef } from "../store/timeline.js";

const formatClock = (recordedAt: string): string => {
  const date = new Date(recordedAt);
  if (Number.isNaN(date.getTime())) return recordedAt;
  return date.toISOString().slice(11, 23);
};

const labelFor = (ref: ElementRef): string => ref.split(":").slice(1).join(":") || ref;

/**
 * Every placeless scope opens as a portal (`VIEW_DESIGN.md`'s two-layer
 * rule). This is the agent storyline portal: a vertical strip of one
 * element's own timeline slice, in `t` order, with a "now" line rendered at
 * the global cursor — rows after it are dimmed, never hidden, so the whole
 * storyline stays visible while still reading "as of now" at a glance.
 * Clicking a row jumps the *global* cursor (rule 7: portals are
 * time-linked, never privately clocked), which is why this reads and
 * writes the same `timelineStore` every other view does.
 */
export function StorylinePortal({ elementRef }: { elementRef: ElementRef }) {
  const { timeline, cursor } = useTimelineStore();
  const rows = useMemo(() => (timeline ? eventsForElement(timeline, elementRef) : []), [timeline, elementRef]);

  if (!timeline) return null;

  const nowIndex = rows.findIndex((row) => row.t > cursor);
  const splitAt = nowIndex === -1 ? rows.length : nowIndex;

  return (
    <aside className="storyline-portal" aria-label={`${labelFor(elementRef)} storyline`}>
      <div className="storyline-header">
        <span className="storyline-title">{labelFor(elementRef)}</span>
        <span className="storyline-count">{rows.length} events</span>
        <button aria-label="Close storyline portal" onClick={() => setSelection(null)} type="button">×</button>
      </div>
      <div className="storyline-breadcrumb">world → {labelFor(elementRef)}</div>
      <ol className="storyline-strip">
        {rows.map((row, index) => (
          <li key={row.eventId}>
            {index === splitAt ? <div className="storyline-now-line" aria-hidden="true" /> : null}
            <button
              className={`storyline-row ${row.t <= cursor ? "past" : "future"} ${row.t === cursor ? "current" : ""}`}
              onClick={() => setCursor(row.t)}
              type="button"
            >
              <span className="storyline-t">t={row.t}</span>
              <span className="storyline-clock">{formatClock(row.recordedAt)}</span>
              <span className="storyline-class">{row.viewClass}</span>
              <span className="storyline-text">{row.text ?? row.type}</span>
            </button>
          </li>
        ))}
        {splitAt === rows.length ? <li><div className="storyline-now-line" aria-hidden="true" /></li> : null}
      </ol>
    </aside>
  );
}
