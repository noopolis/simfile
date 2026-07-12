import { useMemo } from "react";

import { closePortal, eventsForElement, setCursor, useTimelineStore, type ElementRef } from "../store/timeline.js";
import { RecallChips } from "./RecallChips.js";

const formatClock = (recordedAt: string): string => {
  const date = new Date(recordedAt);
  if (Number.isNaN(date.getTime())) return recordedAt;
  return date.toISOString().slice(11, 23);
};

const labelFor = (ref: ElementRef): string => ref.split(":").slice(1).join(":") || ref;

const PORTAL_STACK_WIDTH = 336;

/**
 * Every placeless scope opens as a portal (`VIEW_DESIGN.md`'s two-layer
 * rule), and this is the one storyline renderer for every element kind:
 * `agent:`, `room:`, and `bank:` refs all render through the exact same
 * component (increment 2 rule 1 — "one mechanism, all element kinds, no
 * per-kind portal code"), because `eventsForElement` already slices by
 * subject membership regardless of what kind of ref it is.
 *
 * A vertical strip of one element's own timeline slice, in `t` order, with
 * a "now" line rendered at the global cursor — rows after it are dimmed,
 * never hidden, so the whole storyline stays visible while still reading
 * "as of now" at a glance. Clicking a row jumps the *global* cursor (rule 7:
 * portals are time-linked, never privately clocked).
 *
 * `turn.input` rows additionally render `RecallChips`: the `mneme:`-caused
 * recall edge (increment 2 rule 2), and any row whose event id is in the
 * shared `highlightedEventIds` set (set by hovering/selecting a recall chip
 * in this or any other open portal) renders with the `highlighted` class —
 * this is the cross-portal linked-selection mechanism.
 *
 * Multiple portals can be open at once (`openPortals`, a stack, not a
 * single selection) — `stackIndex` offsets this instance so they don't
 * overlap, and closing one (`closePortal`) never touches the others or the
 * map/chat `selection`.
 */
export function StorylinePortal({ elementRef, stackIndex = 0 }: { elementRef: ElementRef; stackIndex?: number }) {
  const { timeline, cursor, highlightedEventIds } = useTimelineStore();
  const rows = useMemo(() => (timeline ? eventsForElement(timeline, elementRef) : []), [timeline, elementRef]);

  if (!timeline) return null;

  const nowIndex = rows.findIndex((row) => row.t > cursor);
  const splitAt = nowIndex === -1 ? rows.length : nowIndex;

  return (
    <aside
      aria-label={`${labelFor(elementRef)} storyline`}
      className="storyline-portal"
      style={{ right: 16 + stackIndex * PORTAL_STACK_WIDTH }}
    >
      <div className="storyline-header">
        <span className="storyline-title">{labelFor(elementRef)}</span>
        <span className="storyline-count">{rows.length} events</span>
        <button aria-label="Close storyline portal" onClick={() => closePortal(elementRef)} type="button">×</button>
      </div>
      <div className="storyline-breadcrumb">world → {labelFor(elementRef)}</div>
      <ol className="storyline-strip">
        {rows.map((row, index) => (
          <li key={row.eventId}>
            {index === splitAt ? <div className="storyline-now-line" aria-hidden="true" /> : null}
            <button
              className={[
                "storyline-row",
                row.t <= cursor ? "past" : "future",
                row.t === cursor ? "current" : "",
                highlightedEventIds.includes(row.eventId) ? "highlighted" : "",
              ].filter(Boolean).join(" ")}
              onClick={() => setCursor(row.t)}
              type="button"
            >
              <span className="storyline-t">t={row.t}</span>
              <span className="storyline-clock">{formatClock(row.recordedAt)}</span>
              <span className="storyline-class">{row.viewClass}</span>
              <span className="storyline-text">{row.text ?? row.type}</span>
            </button>
            {row.viewClass === "turn.input" ? <RecallChips timeline={timeline} turnInput={row} /> : null}
          </li>
        ))}
        {splitAt === rows.length ? <li><div className="storyline-now-line" aria-hidden="true" /></li> : null}
      </ol>
    </aside>
  );
}
