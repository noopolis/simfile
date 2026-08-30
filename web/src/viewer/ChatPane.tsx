import { useMemo, type ReactNode } from "react";

import { RecallChips } from "../portals/RecallChips.js";
import {
  eventsUpTo,
  focusAndOpenPortal,
  membraneForRepresentative,
  setCursor,
  type ElementRef,
  type RunTimeline,
  type TimelineEvent,
} from "../store/timeline.js";
import { membraneColor } from "./membraneColor.js";

const mentionPattern = /@[A-Za-z][\w-]*/gu;

const renderWithMentions = (text: string): ReactNode[] => {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  mentionPattern.lastIndex = 0;
  let key = 0;
  while ((match = mentionPattern.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(<span key={key++}>{text.slice(lastIndex, match.index)}</span>);
    parts.push(<mark key={key++} className="mention">{match[0]}</mark>);
    lastIndex = match.index + match[0].length;
  }
  parts.push(<span key={key++}>{text.slice(lastIndex)}</span>);
  return parts;
};

export const participantChatMessages = (
  timeline: RunTimeline,
  cursor: number,
  roomFilter?: ReadonlySet<ElementRef>,
): TimelineEvent[] => {
  const participantRefs = new Set(
    timeline.elements.filter(({ kind }) => kind === "agent").map(({ ref }) => ref),
  );
  return eventsUpTo(timeline, cursor).filter((event) =>
    event.viewClass === "message"
    && event.actor !== undefined
    && typeof event.text === "string"
    && event.text.trim().length > 0
    && (participantRefs.has(event.actor) || participantRefs.has(`agent:${event.actor}`))
    && (!roomFilter || event.subjects.some((subject) => roomFilter.has(subject))));
};

export function ChatPane({
  timeline,
  cursor,
  utteredEventIds,
  roomFilter,
}: {
  timeline: RunTimeline;
  cursor: number;
  utteredEventIds?: ReadonlySet<string>;
  roomFilter?: ReadonlySet<ElementRef>;
}) {
  const messages = useMemo(
    () => participantChatMessages(timeline, cursor, roomFilter),
    [timeline, cursor, roomFilter],
  );

  return (
    <section className="replay-pane replay-chat" aria-label="Room chat">
      <header className="replay-pane-header">room chat · {messages.length} messages as of t={cursor}</header>
      <div className="replay-pane-body">
        {messages.map((message) => {
          const chips = timeline.events.filter((event) => event.causes.includes(message.eventId));
          const isWorldEcho = message.authority === "moltnet" && Boolean(message.worldEventId);
          const isSeed = utteredEventIds?.has(message.eventId) ?? false;
          const asMembrane = message.actor
            ? membraneForRepresentative(timeline, `agent:${message.actor}`)
            : undefined;
          return (
            <article
              className="chat-message"
              key={message.eventId}
              style={asMembrane ? { borderLeft: `2px solid ${membraneColor(asMembrane.ref)}`, paddingLeft: 6 } : undefined}
            >
              <div className="chat-message-head">
                <button
                  className="chat-author"
                  onClick={() => (message.actor ? focusAndOpenPortal(`agent:${message.actor}`) : undefined)}
                  type="button"
                >
                  {message.actor ?? "unknown"}
                </button>
                {asMembrane ? (
                  <span
                    className="chat-badge boundary-badge"
                    style={{ borderColor: membraneColor(asMembrane.ref), color: membraneColor(asMembrane.ref) }}
                    title={`Crosses the ${asMembrane.label} membrane boundary`}
                  >
                    boundary · {asMembrane.label}
                  </span>
                ) : null}
                {isWorldEcho ? <span className="chat-badge chat-badge-world">world</span> : null}
                {isSeed ? <span className="chat-badge chat-badge-seed">🧬 seed</span> : null}
                <span className="chat-time">{message.recordedAt.slice(11, 19)}</span>
              </div>
              <p className="chat-text">{renderWithMentions(message.text ?? "")}</p>
              {chips.length > 0 ? (
                <div className="chat-chips">
                  {chips.map((chip) => (
                    <span className="chat-chip-group" key={chip.eventId}>
                      <button className="chat-chip" onClick={() => setCursor(chip.t)} type="button">
                        {chip.viewClass}
                      </button>
                      {chip.viewClass === "turn.input" ? <RecallChips timeline={timeline} turnInput={chip} /> : null}
                    </span>
                  ))}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
