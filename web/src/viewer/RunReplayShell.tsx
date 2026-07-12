import { useEffect, useMemo, useRef, useState } from "react";

import {
  focusAndOpenPortal,
  loadTimeline,
  setLoadError,
  useTimelineStore,
  type RunTimeline,
} from "../store/timeline.js";
import { applyDeepLink, parseDeepLink, startDeepLinkSync } from "../store/deepLink.js";
import { ScrubBar } from "../chrome/ScrubBar.js";
import { StorylinePortal } from "../portals/StorylinePortal.js";
import { AsciiMap } from "./AsciiMap.js";
import { ChatPane, MindsRail } from "./ReplayPanes.js";
import {
  ProvenancePanel,
  SpreadReadout,
  VariableGaugeRail,
  VerdictStrip,
  useProvenancePanel,
  type RunMeta,
} from "./RunMetaPanels.js";
import { defaultRenderSettings } from "./renderSettings.js";
import { firstAppearanceGlowScopes, seedSpreadEventIds, utteredEventIds } from "./spreadModel.js";
import { buildViewerWorld, viewerSkins } from "./worldModel.js";
import type { ViewerContractTrace, ViewerWorldResponse } from "./types.js";
import "../styles-replay.css";

/**
 * The run-replay hybrid shell (`VIEW_DESIGN.md` two-layer rule + rule 7):
 * the existing GlyphCSS map on one side, the placeless room chat and minds
 * rail (`ReplayPanes.tsx`) as time-linked panes, a stack of storyline
 * portals (`StorylinePortal.tsx`, one mechanism for every element kind), a
 * verdict/provenance readout ported from the retired bespoke run page
 * (`RunMetaPanels.tsx`), and one global `ScrubBar` — every pane reads its
 * "as of" slice from `timelineStore`. This is a sibling of `App.tsx` (the
 * world/live console), selected by `main.tsx` from
 * `/api/state.mode === "run-replay"` — `App.tsx` itself is untouched.
 */

const fetchJson = async <T,>(url: string): Promise<T> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);
  return response.json() as Promise<T>;
};

export function RunReplayShell() {
  const { timeline, cursor, selection, openPortals, loadError } = useTimelineStore();
  const [worldTrace, setWorldTrace] = useState<ViewerContractTrace | null>(null);
  const [worldError, setWorldError] = useState<string | null>(null);
  const [runMeta, setRunMeta] = useState<RunMeta | null>(null);
  const provenancePanel = useProvenancePanel();
  const deepLinkApplied = useRef(false);

  useEffect(() => {
    void fetchJson<RunTimeline>("/api/timeline")
      .then(loadTimeline)
      .catch((error: unknown) => setLoadError(error instanceof Error ? error.message : String(error)));

    void fetchJson<ViewerWorldResponse>("/api/world")
      .then((response) => setWorldTrace(response.trace))
      .catch((error: unknown) => setWorldError(error instanceof Error ? error.message : String(error)));

    void fetchJson<RunMeta>("/api/run-meta")
      .then(setRunMeta)
      .catch(() => setRunMeta(null));

    // Global-chrome-owned side effect (never a component-local clock, rule 7):
    // mirrors cursor/selection/open-portals into the URL as the user scrubs.
    return startDeepLinkSync();
  }, []);

  useEffect(() => {
    // Deep-link restore (increment 2 rule 4) runs once, as soon as the
    // timeline is loaded — `at` needs the loaded events to resolve an
    // event id to its *current* `t`.
    if (!timeline || deepLinkApplied.current) return;
    deepLinkApplied.current = true;
    applyDeepLink(timeline, parseDeepLink(window.location.search));
  }, [timeline]);

  const world = useMemo(() => (worldTrace ? buildViewerWorld(worldTrace) : null), [worldTrace]);
  const selectedNode = useMemo(
    () => world?.nodes.find((node) => node.scope === selection) ?? world?.nodes[0] ?? null,
    [world, selection],
  );
  const skin = viewerSkins[0]!;
  const caption = worldTrace?.rooms[0]?.access_hint;

  // Increment 3: the seeded meme's spread, joined against the loaded timeline/world
  // — all graceful-absence (empty sets / []) when the run has no seed declaration.
  const uttered = useMemo(() => utteredEventIds(runMeta?.seedSpread), [runMeta]);
  const spreadDotIds = useMemo(() => seedSpreadEventIds(runMeta?.seedSpread), [runMeta]);
  const roomScope = worldTrace?.rooms[0]?.scope;
  const glowScopes = useMemo(
    () =>
      new Set(
        timeline
          ? firstAppearanceGlowScopes({ spreadSummary: runMeta?.spreadSummary, timeline, cursor, roomScope })
          : [],
      ),
    [timeline, runMeta, cursor, roomScope],
  );

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

  return (
    <main className={`viewer-shell replay-shell ${skin.className}`}>
      <header className="topbar">
        <div className="topbar-title">
          <span className="sigil">▦</span>
          <span className="brand">SIMFILE</span>
          <span className="version">run-replay</span>
          <span className="run-name">{timeline.runId}</span>
        </div>
        {runMeta ? <VerdictStrip meta={runMeta} onOpenProvenance={provenancePanel.toggle} /> : null}
        {runMeta?.spreadSummary ? (
          <SpreadReadout participants={runMeta.participants} seedSpread={runMeta.seedSpread ?? []} summary={runMeta.spreadSummary} />
        ) : null}
        <VariableGaugeRail samples={runMeta?.variableSamples} />
      </header>

      <div className="replay-grid">
        <section className="replay-pane replay-map" aria-label="World map">
          <header className="replay-pane-header">world map</header>
          {caption ? <p className="replay-caption">{caption}</p> : null}
          {world && selectedNode ? (
            <AsciiMap
              glowScopes={glowScopes}
              nodes={world.nodes}
              onSelect={(id) => {
                const node = world.nodes.find((candidate) => candidate.id === id);
                if (node) focusAndOpenPortal(node.scope);
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

        <ChatPane cursor={cursor} timeline={timeline} utteredEventIds={uttered} />
        <MindsRail cursor={cursor} timeline={timeline} />
      </div>

      {openPortals.map((ref, index) => (
        <StorylinePortal elementRef={ref} key={ref} stackIndex={index} />
      ))}

      {runMeta && provenancePanel.open ? <ProvenancePanel meta={runMeta} onClose={provenancePanel.close} /> : null}

      <ScrubBar seedSpreadEventIds={spreadDotIds} />
    </main>
  );
}
