import { setCursor, type RunTimeline, type TimelineEvent } from "../store/timeline.js";
import { RecallChips } from "./RecallChips.js";

/**
 * The vertical "now"-lined event strip, shared by `StorylinePortal.tsx`'s
 * default flat rendering and `MembraneView.tsx`'s "crossings" tab — one row
 * renderer, not two copies of the same now-line/highlight/recall-chip logic
 * (`AGENTS.md`: extend `StorylinePortal`'s rendering, don't fork it).
 * Clicking a row jumps the *global* cursor (rule 7), never a private one.
 */

const formatClock = (recordedAt: string): string => {
  const date = new Date(recordedAt);
  if (Number.isNaN(date.getTime())) return recordedAt;
  return date.toISOString().slice(11, 23);
};

export function StorylineRows({
  timeline,
  rows,
  cursor,
  highlightedEventIds,
}: {
  timeline: RunTimeline;
  rows: readonly TimelineEvent[];
  cursor: number;
  highlightedEventIds: readonly string[];
}) {
  const nowIndex = rows.findIndex((row) => row.t > cursor);
  const splitAt = nowIndex === -1 ? rows.length : nowIndex;

  return (
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
  );
}
