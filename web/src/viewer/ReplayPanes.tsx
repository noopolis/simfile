import React, { useMemo, useState } from "react";
import type { ReactNode } from "react";

import {
  eventsForElement,
  focusAndOpenPortal,
  membraneForRepresentative,
  setCursor,
  type ElementRef,
  type RunTimeline,
  type RunTimelineElement,
  type TimelineEvent,
} from "../store/timeline.js";
import { participantRef, type ActionFeedRow } from "./actionFeed.js";
import { actionLogUpToTick, buildActionLog } from "./actionLog.js";
import { declarationFacts } from "./actionNarration.js";
import { narrateAction } from "./actionNarrators.js";
import {
  commitmentSpanInForceAt,
  commitmentSpans,
} from "./commitmentSpans.js";
import { membraneColor } from "./membraneColor.js";
import { tickAtCursor } from "./variableModel.js";
export { ChatPane, participantChatMessages } from "./ChatPane.js";

/**
 * The minds rail, split out of `RunReplayShell.tsx` to keep the shell focused
 * on layout and loading. Room chat lives in `ChatPane.tsx` and is re-exported
 * here for the existing pane entry point.
 */

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

function MindStratum({
  kind,
  stamp,
  text,
  note,
}: {
  kind: string;
  stamp?: string;
  text: string;
  note?: string;
}) {
  return (
    <li className={`stratum-${kind}`}>
      <span className="stratum-kind">{kind}</span>
      {stamp === undefined ? null : <span className="stratum-tick">{stamp}</span>}
      <span className="stratum-text">{text}</span>
      {note === undefined ? null : <span className="stratum-text">{note}</span>}
    </li>
  );
}

function MindStrata({ rows }: { rows: readonly TimelineEvent[] }) {
  return (
    <ol className="mind-strata">
      {rows.slice(-6).map((row) => {
        const kind = row.viewClass.split(".")[1]!;
        return <MindStratum kind={kind} key={row.eventId} text={row.text ?? row.type} />;
      })}
    </ol>
  );
}

type PresentedAct = Readonly<{
  presentation: { readonly note?: string; readonly text: string };
  row: ActionFeedRow;
}>;

/** Drops a controller namespace when presenting a key in a narrow rail. */
const shortMind = (key: string): string => key.split(":").slice(1).join(":") || key;

interface RecordedMind {
  readonly entries: readonly PresentedAct[];
  readonly live: number;
  readonly standing: readonly { readonly held: boolean; readonly text: string }[];
  readonly actors: readonly string[];
  readonly key: string;
  readonly ref: ElementRef | undefined;
  readonly wakes: number;
}

/**
 * Rows are keyed by the recorded verb, so the colour axis comes from the
 * record rather than from a list of names this viewer knows.
 */
const mindRowKind = (verb: string): string =>
  verb.replace(/[^a-z0-9]+/giu, "-").toLowerCase();

/** Opened from the rail. One scrollable table of one-line rows. */
function MindModal({
  entry,
  onClose,
}: {
  entry: RecordedMind;
  onClose: () => void;
}) {
  const scroller = React.useRef<HTMLDivElement | null>(null);
  const kinds = useMemo(
    () => [...new Set(entry.entries.map(({ row }) => row.verb))],
    [entry],
  );

  // Stream: keep the newest wake in view as the cursor advances.
  React.useEffect(() => {
    const node = scroller.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [entry.entries.length]);

  return (
    <div className="mind-modal-scrim" onClick={onClose} role="presentation">
      <section
        aria-label={`mind ${entry.key}`}
        className="mind-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="mind-modal-header">
          <span className="mind-modal-title">{shortMind(entry.key)}</span>
          <span className="feed-muted">
            through {entry.actors.join(", ")} · {entry.wakes} wakes ·
            {" "}{entry.live} standing
          </span>
          <button aria-label="close" onClick={onClose} type="button">x</button>
        </header>

        {/* What the reader is looking at, in the reader's terms. */}
        <p className="mind-legend">
          <span className="mind-legend-item">
            <span className="mind-dot mind-dot-held" /> standing — still in force
          </span>
          {kinds.map((verb) => (
            <span className="mind-legend-item" key={verb}>
              <span className={`mind-dot mind-kind-${mindRowKind(verb)}`} />
              {verb.replace(/_/gu, " ")} — what it decided
            </span>
          ))}
          <span className="mind-legend-note">
            one row per wake · newest last
          </span>
        </p>

        <div className="mind-modal-body" ref={scroller}>
          <ol className="mind-table">
            {entry.standing.map((standing, index) => (
              <li
                className={`mind-tr mind-kind-held${standing.held ? "" : " mind-tr-stale"}`}
                key={`${entry.key}:held:${index}`}
              >
                <span className="mind-td-tick">standing</span>
                <span className="mind-td-kind">held</span>
                <span className="mind-td-text">{standing.text}</span>
              </li>
            ))}
            {entry.entries.map(({ presentation, row }) => (
              <li
                className={`mind-tr mind-kind-${mindRowKind(row.verb)}`}
                key={`${row.eventId}:${row.actId}`}
              >
                <button
                  className="mind-td-tick mind-td-button"
                  onClick={() => setCursor(row.t)}
                  type="button"
                >
                  t{row.tick}
                </button>
                <span className="mind-td-kind">
                  {row.verb.replace(/_/gu, " ")}
                </span>
                <span className="mind-td-text" title={presentation.note}>
                  {presentation.text}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </div>
  );
}

function RecordedStrata({ rows }: { rows: readonly PresentedAct[] }) {
  const lastTicks = [...new Set(rows.map(({ row }) => row.tick))].slice(-6);
  const visible = rows.filter(({ row }) => lastTicks.includes(row.tick));
  return (
    <ol className="mind-strata">
      {visible.map(({ presentation, row }) => (
        <MindStratum
          kind="wake"
          key={`${row.eventId}:${row.actId}`}
          note={presentation.note}
          stamp={`t${row.tick}`}
          text={presentation.text}
        />
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
  const recorded = useMemo(() => {
    // Overrides are element-scoped membrane interiors. Recorded principals
    // without a membership element stay on the outer rail.
    if (agentsOverride !== undefined || banksOverride !== undefined) return [];
    const tick = tickAtCursor(timeline, cursor);
    const log = buildActionLog(timeline);
    // The record makes declarations eligible. Extensions may phrase them, but
    // structural facts keep the rail present when no extension can.
    const rows = actionLogUpToTick(log, tick).flatMap((row): PresentedAct[] => {
      if (row.phase !== "action") return [];
      const narration = narrateAction({ row });
      const facts = declarationFacts(row.input);
      const presentation = narration ?? {
        ...(facts.length === 0 ? {} : {
          note: facts.map(({ label, value }) => `${label}: ${value}`).join(" · "),
        }),
        text: [row.verb, row.actor].filter(Boolean).join(" · "),
      };
      return [{ presentation, row }];
    });
    const spans = commitmentSpans(timeline);
    const grouped = new Map<string, PresentedAct[]>();
    for (const item of rows) {
      const key = item.row.participant;
      const current = grouped.get(key) ?? [];
      current.push(item);
      grouped.set(key, current);
    }
    return [...grouped.entries()].map(([key, entries]) => {
      const actIds = new Set(entries.map(({ row }) => row.actId));
      const relevant = tick === undefined ? [] : spans.filter((span) =>
        actIds.has(span.actId) && span.declaredAtTick <= tick);
      const held = tick === undefined ? [] : relevant.filter((span) =>
        commitmentSpanInForceAt(span, tick));
      const latestTick = relevant.at(-1)?.declaredAtTick;
      const standing = held.length > 0 ? held : relevant.filter((span) =>
        span.declaredAtTick === latestTick);
      return {
        entries,
        live: held.length,
        standing: standing.flatMap((span) => {
          const item = entries.find(({ row }) => row.actId === span.actId);
          return item === undefined ? [] : [{
            held: commitmentSpanInForceAt(span, tick!),
            text: item.presentation.text,
          }];
        }),
        actors: [...new Set(entries.flatMap(({ row }) =>
          row.actor === undefined ? [] : [row.actor]))],
        key,
        ref: participantRef(timeline, key),
        wakes: new Set(entries.map(({ row }) => row.tick)).size,
      };
    });
  }, [timeline, cursor, agentsOverride, banksOverride]);

  const memoryEventsAsOf = (ref: ElementRef): TimelineEvent[] =>
    eventsForElement(timeline, ref).filter((event) => event.t <= cursor && event.viewClass.startsWith("memory."));

  const [openMind, setOpenMind] = useState<string | undefined>(undefined);

  const boundaryBadge = (agentRef: ElementRef): ReactNode =>
    membraneForRepresentative(timeline, agentRef) ? <span className="boundary-badge">boundary</span> : null;

  const open = recorded.find((entry) => entry.key === openMind);

  return (
    <aside className="replay-pane replay-minds" aria-label="Minds rail">
      <header className="replay-pane-header">
        minds · {recorded.length + agents.length}
      </header>
      {open === undefined ? null : (
        <MindModal
          entry={open}
          onClose={() => setOpenMind(undefined)}
        />
      )}
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
        {/* Recorded principals stay a parallel source: elements mint agents
            only for stream emitters, and an acted-through object is not one.
            Each is a COMPACT ROW; detail opens in a modal, so the rail stays a
            readable index instead of every mind expanded at once. */}
        {recorded.map((entry) => (
          <button
            className="mind-row"
            key={entry.key}
            onClick={() => setOpenMind(entry.key)}
            type="button"
          >
            <span className="mind-row-name">{shortMind(entry.key)}</span>
            <span className="mind-row-stat">{entry.wakes} wakes</span>
            <span className="mind-row-stat">{entry.live} live</span>
            <span className="mind-row-open">open</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
