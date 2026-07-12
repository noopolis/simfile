import { useMemo } from "react";
import type { ReactNode } from "react";

import {
  echoedWorldEventIds,
  eventsForElement,
  eventsUpTo,
  focusAndOpenPortal,
  membraneForRepresentative,
  setCursor,
  type ElementRef,
  type RunTimeline,
  type RunTimelineElement,
  type TimelineEvent,
} from "../store/timeline.js";
import { RecallChips } from "../portals/RecallChips.js";
import { membraneColor } from "./membraneColor.js";

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

/**
 * Increment 3's world/moltnet dedup + seed badges: `utteredEventIds` (the
 * `uttered`-channel `seed_spread` event ids, from `../viewer/spreadModel.ts`,
 * `undefined` for a run with no seed declaration) marks a message with the
 * "🧬 seed" badge; every moltnet message with a `worldEventId` (it echoes a
 * real world action) gets the "world" badge; and — the dedup rule itself —
 * a `world`-authority `world.message`/`world.dm` event whose id has a
 * moltnet echo (`echoedWorldEventIds`) is filtered out here entirely, so
 * only its badged moltnet twin ever renders. A `world`-authority message
 * that survives the filter (no echo at all) renders standalone, flagged
 * "not delivered."
 */
export function ChatPane({
  timeline,
  cursor,
  utteredEventIds,
  roomFilter,
}: {
  timeline: RunTimeline;
  cursor: number;
  utteredEventIds?: ReadonlySet<string>;
  /**
   * When set, only messages whose `subjects` intersect this set render —
   * the membrane portal's interior chat scoped to its own `interiorRooms`
   * (`VIEW_DESIGN.md` rule 5's membrane view). Omitted for the outer/commons
   * chat, unchanged from before membranes existed.
   */
  roomFilter?: ReadonlySet<ElementRef>;
}) {
  const echoedWorldIds = useMemo(() => echoedWorldEventIds(timeline.events), [timeline]);
  const messages = useMemo(
    () =>
      eventsUpTo(timeline, cursor).filter(
        (event) =>
          event.viewClass === "message" &&
          !(event.authority === "world" && echoedWorldIds.has(event.eventId)) &&
          (!roomFilter || event.subjects.some((subject) => roomFilter.has(subject))),
      ),
    [timeline, cursor, echoedWorldIds, roomFilter],
  );

  return (
    <section className="replay-pane replay-chat" aria-label="Room chat">
      <header className="replay-pane-header">room chat · {messages.length} messages as of t={cursor}</header>
      <div className="replay-pane-body">
        {messages.map((message) => {
          const chips = downstreamOf(timeline, message.eventId);
          // Any world-authority message reaching this point has no moltnet echo (the echoed ones were filtered above).
          const isUndeliveredWorld = message.authority === "world";
          const isWorldEcho = message.authority === "moltnet" && Boolean(message.worldEventId);
          const isSeed = utteredEventIds?.has(message.eventId) ?? false;
          // Representative = boundary crossing (VIEW_DESIGN.md's crossing
          // vocabulary): a message authored by a membrane's own
          // representative carries that membrane's color, wherever it's
          // rendered — it's the one voice that crosses the interior/exterior
          // boundary.
          const asMembrane = message.actor ? membraneForRepresentative(timeline, `agent:${message.actor}`) : undefined;
          return (
            <article
              className={["chat-message", isUndeliveredWorld ? "chat-message-undelivered" : ""].filter(Boolean).join(" ")}
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
                {isWorldEcho ? (
                  <span className="chat-badge chat-badge-world" title="Originated from a world action, delivered through moltnet">world</span>
                ) : null}
                {isSeed ? (
                  <span className="chat-badge chat-badge-seed" title="Carries the seeded secret's token (seed_spread: uttered)">🧬 seed</span>
                ) : null}
                {isUndeliveredWorld ? (
                  <span className="chat-badge chat-badge-undelivered" title="No moltnet echo recorded for this world message">not delivered</span>
                ) : null}
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

export function MindsRail({
  timeline,
  cursor,
  agents: agentsOverride,
  banks: banksOverride,
}: {
  timeline: RunTimeline;
  cursor: number;
  /**
   * Restricts the rail to exactly these agents/banks — the membrane
   * portal's interior minds rail (`../store/timeline.ts`'s
   * `agentsForMembrane`/`banksForMembrane`). Omitted for the outer rail,
   * unchanged from before membranes existed (every agent/bank in the run).
   */
  agents?: RunTimelineElement[];
  banks?: RunTimelineElement[];
}) {
  const banks = useMemo(() => banksOverride ?? timeline.elements.filter((element) => element.kind === "bank"), [timeline, banksOverride]);
  const agents = useMemo(() => agentsOverride ?? timeline.elements.filter((element) => element.kind === "agent"), [timeline, agentsOverride]);

  const memoryEventsAsOf = (ref: ElementRef): TimelineEvent[] =>
    eventsForElement(timeline, ref).filter((event) => event.t <= cursor && event.viewClass.startsWith("memory."));

  const boundaryBadge = (agentRef: ElementRef): ReactNode =>
    membraneForRepresentative(timeline, agentRef) ? <span className="boundary-badge">boundary</span> : null;

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
                      {agentRef.split(":").slice(1).join(":")} {boundaryBadge(agentRef)} <span>{rows.length}</span>
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
                  {agent.label} {boundaryBadge(agent.ref)} <span>{strata.length}</span>
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
