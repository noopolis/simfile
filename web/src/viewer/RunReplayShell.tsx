import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import {
  eventsForElement,
  eventsUpTo,
  loadTimeline,
  setCursor,
  setLoadError,
  setSelection,
  useTimelineStore,
  type ElementRef,
  type RunTimeline,
  type TimelineEvent,
} from "../store/timeline.js";
import { ScrubBar } from "../chrome/ScrubBar.js";
import { StorylinePortal } from "../portals/StorylinePortal.js";
import { AsciiMap } from "./AsciiMap.js";
import { defaultRenderSettings } from "./renderSettings.js";
import { buildViewerWorld, viewerSkins } from "./worldModel.js";
import type { ViewerContractTrace, ViewerWorldResponse } from "./types.js";
import "../styles-replay.css";

/**
 * The run-replay hybrid shell (`VIEW_DESIGN.md` two-layer rule + rule 7):
 * the existing GlyphCSS map on one side, the placeless chat room and minds
 * rail as portals beside it, and one global `ScrubBar` at the bottom that
 * every pane reads its "as of" slice from via `timelineStore`. This is a
 * sibling of `App.tsx` (the world/live console), selected by `main.tsx`
 * from `/api/state.mode === "run-replay"` — `App.tsx` itself is untouched.
 */

const fetchJson = async <T,>(url: string): Promise<T> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);
  return response.json() as Promise<T>;
};

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

function ChatPane({ timeline, cursor }: { timeline: RunTimeline; cursor: number }) {
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
                <button className="chat-author" onClick={() => setSelection(message.actor ? `agent:${message.actor}` : null)} type="button">
                  {message.actor ?? "unknown"}
                </button>
                <span className="chat-time">{message.recordedAt.slice(11, 19)}</span>
              </div>
              <p className="chat-text">{renderWithMentions(message.text ?? "")}</p>
              {chips.length > 0 ? (
                <div className="chat-chips">
                  {chips.map((chip) => (
                    <button className="chat-chip" key={chip.eventId} onClick={() => setCursor(chip.t)} type="button">
                      {chip.viewClass}
                    </button>
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

function MindsRail({ timeline, cursor }: { timeline: RunTimeline; cursor: number }) {
  const agents = useMemo(() => timeline.elements.filter((element) => element.kind === "agent"), [timeline]);

  return (
    <aside className="replay-pane replay-minds" aria-label="Minds rail">
      <header className="replay-pane-header">minds</header>
      <div className="replay-pane-body">
        {agents.map((agent) => {
          const strata = eventsForElement(timeline, agent.ref)
            .filter((event) => event.t <= cursor && event.viewClass.startsWith("memory."));
          return (
            <div className="mind-portal" key={agent.ref}>
              <button className="mind-header" onClick={() => setSelection(agent.ref)} type="button">
                {agent.label} <span>{strata.length}</span>
              </button>
              <ol className="mind-strata">
                {strata.slice(-6).map((row) => (
                  <li className={`stratum-${row.viewClass.split(".")[1]}`} key={row.eventId}>
                    <span className="stratum-kind">{row.viewClass.split(".")[1]}</span>
                    <span className="stratum-text">{row.text ?? row.type}</span>
                  </li>
                ))}
              </ol>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

export function RunReplayShell() {
  const { timeline, cursor, selection, loadError } = useTimelineStore();
  const [worldTrace, setWorldTrace] = useState<ViewerContractTrace | null>(null);
  const [worldError, setWorldError] = useState<string | null>(null);

  useEffect(() => {
    void fetchJson<RunTimeline>("/api/timeline")
      .then(loadTimeline)
      .catch((error: unknown) => setLoadError(error instanceof Error ? error.message : String(error)));

    void fetchJson<ViewerWorldResponse>("/api/world")
      .then((response) => setWorldTrace(response.trace))
      .catch((error: unknown) => setWorldError(error instanceof Error ? error.message : String(error)));
  }, []);

  const world = useMemo(() => (worldTrace ? buildViewerWorld(worldTrace) : null), [worldTrace]);
  const selectedNode = useMemo(
    () => world?.nodes.find((node) => node.scope === selection) ?? world?.nodes[0] ?? null,
    [world, selection],
  );
  const skin = viewerSkins[0]!;
  const caption = worldTrace?.rooms[0]?.access_hint;

  if (loadError) {
    return (
      <main className="viewer-shell replay-shell">
        <p className="replay-error">Failed to load run timeline: {loadError}</p>
      </main>
    );
  }

  if (!timeline) {
    return (
      <main className="viewer-shell replay-shell">
        <p className="replay-loading">loading run timeline…</p>
      </main>
    );
  }

  const portalRef: ElementRef | null = selection && selection.startsWith("agent:") ? selection : null;

  return (
    <main className={`viewer-shell replay-shell ${skin.className}`}>
      <header className="topbar">
        <div className="topbar-title">
          <span className="sigil">▦</span>
          <span className="brand">SIMFILE</span>
          <span className="version">run-replay</span>
          <span className="run-name">{timeline.runId}</span>
        </div>
      </header>

      <div className="replay-grid">
        <section className="replay-pane replay-map" aria-label="World map">
          <header className="replay-pane-header">world map</header>
          {caption ? <p className="replay-caption">{caption}</p> : null}
          {world && selectedNode ? (
            <AsciiMap
              nodes={world.nodes}
              onSelect={(id) => {
                const node = world.nodes.find((candidate) => candidate.id === id);
                setSelection(node?.scope ?? null);
              }}
              renderSettings={defaultRenderSettings}
              roomPaths={world.roomPaths}
              rooms={world.roomGeometries}
              selectedNode={selectedNode}
              selectedSkin={skin}
            />
          ) : (
            <p className="replay-loading">{worldError ?? "loading world…"}</p>
          )}
        </section>

        <ChatPane cursor={cursor} timeline={timeline} />
        <MindsRail cursor={cursor} timeline={timeline} />
      </div>

      {portalRef ? <StorylinePortal elementRef={portalRef} /> : null}

      <ScrubBar />
    </main>
  );
}
