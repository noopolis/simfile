import { useMemo } from "react";
import type { ReactNode } from "react";

import {
  eventsForElement,
  eventsUpTo,
  focusAndOpenPortal,
  setCursor,
  type ElementRef,
  type RunTimeline,
  type RunTimelineElement,
  type TimelineEvent,
} from "../store/timeline.js";
import { RecallChips } from "../portals/RecallChips.js";

/**
 * The room chat pane and the minds rail — split out of `RunReplayShell.tsx`
 * to keep that file focused on shell/layout/data-loading (`AGENTS.md`: keep
 * files under 400 lines, split early). Both panes open storyline portals
 * through the single `focusAndOpenPortal` mechanism (increment 2 rule 1):
 * there is no agent-only, room-only, or bank-only open path.
 */

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

const downstreamOf = (timeline: RunTimeline, eventId: string): TimelineEvent[] =>
  timeline.events.filter((event) => event.causes.includes(eventId));

export function ChatPane({ timeline, cursor }: { timeline: RunTimeline; cursor: number }) {
  const messages = useMemo(
    () => eventsUpTo(timeline, cursor).filter((event) => event.viewClass === "message"),
    [timeline, cursor],
  );

  return (
    <section className="replay-pane replay-chat" aria-label="Room chat">
      <header className="replay-pane-header">room chat · {messages.length} messages as of t={cursor}</header>
      <div className="replay-pane-body">
        {messages.map((message) => {
          const chips = downstreamOf(timeline, message.eventId);
          return (
            <article className="chat-message" key={message.eventId}>
              <div className="chat-message-head">
                <button
                  className="chat-author"
                  onClick={() => (message.actor ? focusAndOpenPortal(`agent:${message.actor}`) : undefined)}
                  type="button"
                >
                  {message.actor ?? "unknown"}
                </button>
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

/** Groups one bank's memory events (already cursor-filtered) by the agent ref found in their `subjects`. */
const groupByAgent = (
  events: readonly TimelineEvent[],
  agents: readonly RunTimelineElement[],
): [ElementRef, TimelineEvent[]][] => {
  const byAgent = new Map<ElementRef, TimelineEvent[]>();
  for (const event of events) {
    const agentRef = agents.find((agent) => event.subjects.includes(agent.ref))?.ref;
    if (!agentRef) continue;
    const rows = byAgent.get(agentRef) ?? [];
    rows.push(event);
    byAgent.set(agentRef, rows);
  }
  return [...byAgent.entries()];
};

function MindStrata({ rows }: { rows: readonly TimelineEvent[] }) {
  return (
    <ol className="mind-strata">
      {rows.slice(-6).map((row) => (
        <li className={`stratum-${row.viewClass.split(".")[1]}`} key={row.eventId}>
          <span className="stratum-kind">{row.viewClass.split(".")[1]}</span>
          <span className="stratum-text">{row.text ?? row.type}</span>
        </li>
      ))}
    </ol>
  );
}

export function MindsRail({ timeline, cursor }: { timeline: RunTimeline; cursor: number }) {
  const banks = useMemo(() => timeline.elements.filter((element) => element.kind === "bank"), [timeline]);
  const agents = useMemo(() => timeline.elements.filter((element) => element.kind === "agent"), [timeline]);

  const memoryEventsAsOf = (ref: ElementRef): TimelineEvent[] =>
    eventsForElement(timeline, ref).filter((event) => event.t <= cursor && event.viewClass.startsWith("memory."));

  return (
    <aside className="replay-pane replay-minds" aria-label="Minds rail">
      <header className="replay-pane-header">minds</header>
      <div className="replay-pane-body">
        {banks.length > 0 ? (
          banks.map((bank) => {
            const bankEvents = memoryEventsAsOf(bank.ref);
            const byAgent = groupByAgent(bankEvents, agents);
            return (
              <div className="mind-bank" key={bank.ref}>
                <button className="mind-bank-header" onClick={() => focusAndOpenPortal(bank.ref)} type="button">
                  {bank.label} <span>{bankEvents.length}</span>
                </button>
                {byAgent.map(([agentRef, rows]) => (
                  <div className="mind-portal" key={agentRef}>
                    <button className="mind-header" onClick={() => focusAndOpenPortal(agentRef)} type="button">
                      {agentRef.split(":").slice(1).join(":")} <span>{rows.length}</span>
                    </button>
                    <MindStrata rows={rows} />
                  </div>
                ))}
              </div>
            );
          })
        ) : (
          agents.map((agent) => {
            const strata = memoryEventsAsOf(agent.ref);
            return (
              <div className="mind-portal" key={agent.ref}>
                <button className="mind-header" onClick={() => focusAndOpenPortal(agent.ref)} type="button">
                  {agent.label} <span>{strata.length}</span>
                </button>
                <MindStrata rows={strata} />
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
