import { useMemo } from "react";

import {
  recallEventsForTurnInput,
  setCursor,
  setHighlightedEventIds,
  type RunTimeline,
  type TimelineEvent,
} from "../store/timeline.js";

/**
 * Renders a `turn.input` event's `mneme:`-caused recall edge as chips
 * (increment 2 rule 2: "recall fed this turn," made record-backed and
 * clickable). Shared by the chat trace (`../viewer/ReplayPanes.tsx`) and the
 * agent storyline portal (`StorylinePortal.tsx`) — one component, not two
 * copies of the same recall-rendering logic.
 *
 * Hovering or clicking a chip sets `../store/timeline.ts`'s
 * `highlightedEventIds` to that recall's real `memory.recalled` event id;
 * any open bank/agent portal reacts by highlighting the matching row
 * (cross-portal linked selection through the shared store, never direct
 * component messaging). Clicking also moves the global cursor to the
 * recall's own `t`, so "jump to the moment this was recalled" and "see it
 * highlighted in an open portal" are the same click.
 */
export function RecallChips({ timeline, turnInput }: { timeline: RunTimeline; turnInput: TimelineEvent }) {
  const recalls = useMemo(() => recallEventsForTurnInput(timeline, turnInput), [timeline, turnInput]);

  if (recalls.length === 0) return null;

  return (
    <div className="recall-chips" aria-label="memories recalled for this turn">
      {recalls.map((recall) => (
        <button
          className="recall-chip"
          key={recall.eventId}
          onBlur={() => setHighlightedEventIds([])}
          onClick={() => {
            setCursor(recall.t);
            setHighlightedEventIds([recall.eventId]);
          }}
          onFocus={() => setHighlightedEventIds([recall.eventId])}
          onMouseEnter={() => setHighlightedEventIds([recall.eventId])}
          onMouseLeave={() => setHighlightedEventIds([])}
          type="button"
        >
          recall · {recall.text ?? recall.type}
        </button>
      ))}
    </div>
  );
}
