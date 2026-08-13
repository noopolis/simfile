import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  focusAndOpenPortal,
  loadTimeline,
  setCursor,
  setLoadError,
  useTimelineStore,
  type RunTimeline,
} from "../store/timeline.js";
import { applyDeepLink, parseDeepLink, startDeepLinkSync } from "../store/deepLink.js";
import { ScrubBar } from "../chrome/ScrubBar.js";
import { derivePlaybackCadence } from "../chrome/playbackCadence.js";
import { StorylinePortal } from "../portals/StorylinePortal.js";
import { ActionFeedPane } from "./ActionFeedPane.js";
import { AsciiMap } from "./AsciiMap.js";
import { actionLogUpToTick, buildActionLog, type ActionLog } from "./actionLog.js";
import { ChatPane, MindsRail } from "./ReplayPanes.js";
import {
  EngineProvenanceBadge,
  ProvenancePanel,
  SpreadReadout,
  VariableGaugeRail,
  VerdictStrip,
  useProvenancePanel,
  type RunMeta,
} from "./RunMetaPanels.js";
import { defaultRenderSettings } from "./renderSettings.js";
import { firstAppearanceGlowScopes, seedSpreadEventIds, utteredEventIds } from "./spreadModel.js";
import { tickAtCursor } from "./variableModel.js";
import { buildViewerWorld, viewerSkins } from "./worldModel.js";
import { buildWorldMapRendererFrame } from "./worldMapRendererFrame.js";
import { worldMapPresentationTick } from "./worldMapRendererCatalog.js";
import { fetchSealedRunLifecycle } from "./runLifecycle.js";
import {
  livePendingProvenance,
  liveTimeline,
  readRunFrameSse,
} from "./runLiveClient.js";
import { sealedReplayTimeline } from "./spatialReplayTimeline.js";
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

const ignoreSelection = (): void => {};

export function RunReplayShell() {
  const { timeline, cursor, selection, openPortals, loadError } = useTimelineStore();
  const [worldTrace, setWorldTrace] = useState<ViewerContractTrace | null>(null);
  const [worldError, setWorldError] = useState<string | null>(null);
  const [runMeta, setRunMeta] = useState<RunMeta | null>(null);
  const [runMode, setRunMode] = useState<"run-replay" | "run-live" | null>(null);
  const [skippedFrames, setSkippedFrames] = useState(0);
  const [sealed, setSealed] = useState(false);
  const [presentationTick, setPresentationTick] = useState<number | undefined>();
  const provenancePanel = useProvenancePanel();
  const deepLinkApplied = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const load = async (): Promise<void> => {
      const state = await fetchJson<{ mode?: string }>("/api/state");
      const mode = state.mode === "run-live" ? "run-live" : "run-replay";
      setRunMode(mode);
      if (mode === "run-live") {
        loadTimeline(liveTimeline([]));
        const [world, meta] = await Promise.all([
          fetchJson<ViewerWorldResponse>("/api/world"),
          fetchJson<RunMeta>("/api/run-meta"),
        ]);
        setWorldTrace(world.trace);
        setRunMeta({ ...meta, live: true, engineProvenance: livePendingProvenance });
        const response = await fetch("/api/run-frames", { signal: controller.signal });
        if (!response.ok) throw new Error(`GET /api/run-frames failed with ${response.status}`);
        const samples: NonNullable<ViewerContractTrace["spatial_samples"]> = [];
        const timing: NonNullable<RunMeta["timing"]> = [];
        const refreshSealedLifecycle = async (): Promise<void> => {
          const lifecycle = await fetchSealedRunLifecycle();
          loadTimeline(sealedReplayTimeline(
            lifecycle.timeline,
            lifecycle.world.trace.spatial_samples,
          ));
          setWorldTrace(lifecycle.world.trace);
          setRunMeta(lifecycle.runMeta);
          setRunMode(lifecycle.mode);
          setSealed(true);
        };
        await readRunFrameSse(response, (body) => {
          if (typeof body.skippedFrames === "number") {
            const skipped = body.skippedFrames;
            setSkippedFrames((count) => count + skipped);
          }
          if (body.type === "header" && typeof body.simSecondsPerTick === "number") {
            const simSecondsPerTick = body.simSecondsPerTick;
            setRunMeta((current) => current ? { ...current, simSecondsPerTick } : current);
            setWorldTrace((current) => current ? { ...current, tick_duration_ms: simSecondsPerTick * 1_000 } : current);
          }
          if (body.type === "frame" && typeof body.sample === "object" && body.sample !== null) {
            const sample = body.sample as NonNullable<ViewerContractTrace["spatial_samples"]>[number];
            samples.push(sample);
            if (typeof body.timing === "object" && body.timing !== null) timing.push(body.timing as NonNullable<RunMeta["timing"]>[number]);
            const objectIds = new Set(samples.flatMap((entry) => (entry.objects ?? []).map((object) => object.id)));
            setWorldTrace((current) => current ? {
              ...current,
              agents: [
                ...current.agents,
                ...[...objectIds]
                  .filter((id) => !current.agents.some((agent) => agent.id === id))
                  .map((id) => ({ id, scope: id, label: id, detail: "Body placed from the live run's recorded motion track." })),
              ],
              spatial_samples: [...samples],
            } : current);
            loadTimeline(liveTimeline(samples));
            setCursor(samples.length - 1);
            setRunMeta((current) => current ? { ...current, timing: [...timing] } : current);
          }
          if (body.type === "viewer-extension-mismatch") {
            setLoadError(typeof body.error === "string"
              ? `viewer extension failed closed: ${body.error}`
              : "viewer extension failed closed after seal");
          }
          if (body.type === "viewer-extension-data"
            && typeof body.extensionData === "object" && body.extensionData !== null) {
            setWorldTrace((current) => current ? {
              ...current,
              viewer_extension_data: body.extensionData as Readonly<Record<string, unknown>>,
            } : current);
          }
          if (body.type === "sealed") {
            void refreshSealedLifecycle().catch((error: unknown) => {
              setLoadError(error instanceof Error ? error.message : String(error));
            });
          }
        });
      } else {
        const [loadedTimeline, world, meta] = await Promise.all([
          fetchJson<RunTimeline>("/api/timeline"),
          fetchJson<ViewerWorldResponse>("/api/world"),
          fetchJson<RunMeta>("/api/run-meta"),
        ]);
        loadTimeline(sealedReplayTimeline(loadedTimeline, world.trace.spatial_samples));
        setWorldTrace(world.trace);
        setRunMeta(meta);
      }
    };
    void load().catch((error: unknown) => {
      if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : String(error));
    });
    return () => controller.abort();
  }, []);

  useEffect(() => startDeepLinkSync(), []);

  useEffect(() => {
    // Deep-link restore (increment 2 rule 4) runs once, as soon as the
    // timeline is loaded — `at` needs the loaded events to resolve an
    // event id to its *current* `t`.
    if (!timeline || deepLinkApplied.current) return;
    deepLinkApplied.current = true;
    applyDeepLink(timeline, parseDeepLink(window.location.search));
  }, [timeline]);

  const world = useMemo(() => (worldTrace ? buildViewerWorld(worldTrace) : null), [worldTrace]);
  const spatialTickSpan = useMemo<{ firstTick?: number; lastTick?: number }>(() => {
    const samples = worldTrace?.spatial_samples;
    if (!samples || samples.length === 0) return {};
    return { firstTick: samples[0]?.tick, lastTick: samples[samples.length - 1]?.tick };
  }, [worldTrace]);
  const cadence = useMemo(
    () => derivePlaybackCadence({
      eventCount: timeline?.events.length ?? 0,
      events: timeline?.events,
      firstTick: spatialTickSpan.firstTick,
      lastTick: spatialTickSpan.lastTick,
      tickDurationMs: worldTrace?.tick_duration_ms,
      speed: 1,
    }),
    [timeline, spatialTickSpan.firstTick, spatialTickSpan.lastTick, worldTrace?.tick_duration_ms],
  );

  // The recursive membrane portal's outer-map affordance (VIEW_DESIGN.md rule
  // 5) lives on each membrane representative's own agent body; there is no
  // separate synthesized team node. `AsciiMap` renders that body with the "⤵"
  // affordance. The scopes remain `undefined` on a leaf-only run — office-sim
  // regression.
  const descendableScopes = useMemo(() => {
    if (!timeline?.membranes?.length) return undefined;
    const scopes = new Set<string>();
    for (const membrane of timeline.membranes) {
      scopes.add(membrane.ref);
      scopes.add(membrane.representative);
    }
    return scopes;
  }, [timeline]);

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

  // The record's own world tick as of the scrub cursor, obtained from the one
  // cursor-mapping owner and computed once for every tick-aware consumer.
  // `undefined` means the record states no time at all.
  const variableTick = useMemo(
    () => (timeline ? tickAtCursor(timeline, cursor, cadence) : undefined),
    [timeline, cursor, cadence],
  );
  const presentationTickAtCursor = useCallback(
    (selectedCursor: number) => {
      if (!timeline) return undefined;
      const recordedTick = tickAtCursor(timeline, selectedCursor, cadence);
      if (recordedTick !== undefined) return recordedTick;
      if (!world || !selectedNode) return undefined;
      return worldMapPresentationTick(buildWorldMapRendererFrame({
        cursor: {
          eventId: timeline.events[selectedCursor]?.eventId,
          index: selectedCursor,
          max: Math.max(0, timeline.events.length - 1),
        },
        extensionData: world.viewerExtensionData,
        extensionIdentities: world.viewerExtensionIdentities,
        nodes: world.nodes,
        onSelect: ignoreSelection,
        selectedNodeId: selectedNode.id,
        spatialSamples: world.spatialSamples,
        tick: spatialTickSpan.firstTick ?? 0,
        tickDurationMs: world.tickDurationMs,
      }));
    },
    [timeline, cadence, world, selectedNode, spatialTickSpan.firstTick],
  );
  const actionLog = useMemo<ActionLog | undefined>(() => timeline ? buildActionLog(timeline) : undefined, [timeline]);
  const actionRows = useMemo(
    () => actionLog ? actionLogUpToTick(actionLog, variableTick).length : 0,
    [actionLog, variableTick],
  );

  if (loadError) {
    return (
      <main className="viewer-shell replay-shell">
        <p className="replay-error">Failed to load run timeline: {loadError}</p>
      </main>
    );
  }

  if (!timeline || runMode === null) {
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
          <span className="version">{runMode}</span>
          <span className="run-name">{runMode === "run-live" ? "run id: not yet computed — live run has not sealed" : timeline.runId}</span>
        </div>
        {/* Honesty-critical disclosure (unmissable by placement, first thing after
            the run name): whether this run's dialogue is a deterministic scripted
            screenplay or came from a real engine — never omitted, never softened.
            Renders before the verdict strip so it cannot be mistaken for a
            secondary/optional detail. */}
        {runMeta ? <EngineProvenanceBadge provenance={runMeta.engineProvenance ?? livePendingProvenance} /> : null}
        {runMeta ? <VerdictStrip meta={runMeta} onOpenProvenance={provenancePanel.toggle} /> : null}
        {runMode === "run-live" ? <span className="run-live-pending-fact">provenance: not yet computed — the run must seal before provenance is recorded</span> : null}
        {sealed ? <span className="run-live-sealed">sealed — recorded replay</span> : null}
        {runMode === "run-live" && skippedFrames > 0 ? <span className="run-skipped-frames">viewer skipped {skippedFrames} frame{skippedFrames === 1 ? "" : "s"}</span> : null}
        {runMeta?.spreadSummary ? (
          <SpreadReadout participants={runMeta.participants} seedSpread={runMeta.seedSpread ?? []} summary={runMeta.spreadSummary} />
        ) : null}
        <VariableGaugeRail
          onSelectVariable={(variableId) => focusAndOpenPortal(`variable:${variableId}`)}
          samples={runMeta?.variableSamples}
          tick={variableTick}
        />
      </header>

      <div className="replay-grid">
        <div className="replay-secondary-stack replay-left-stack">
          <details className="action-feed-drawer">
            <summary>action log · {actionRows} recorded rows through cursor</summary>
            <ActionFeedPane timeline={timeline} tick={variableTick} />
          </details>
          <MindsRail cursor={cursor} timeline={timeline} />
        </div>

        <section className="replay-pane replay-map" aria-label="World map">
          <header className="replay-pane-header">world map</header>
          {caption ? <p className="replay-caption">{caption}</p> : null}
          {world && selectedNode ? (
            <AsciiMap
              descendableScopes={descendableScopes}
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
              presenceByAgent={world.presenceByAgent}
              spatialSamples={world.spatialSamples}
              tick={presentationTick ?? variableTick}
              tickDurationMs={world.tickDurationMs}
              extensionData={world.viewerExtensionData}
              extensionIdentities={world.viewerExtensionIdentities}
              cursor={{
                eventId: timeline.events[cursor]?.eventId,
                index: cursor,
                max: Math.max(0, timeline.events.length - 1),
              }}
            />
          ) : (
            <p className="replay-loading">{worldError ?? "loading world…"}</p>
          )}
        </section>

        <div className="replay-secondary-stack replay-right-stack">
          <ChatPane cursor={cursor} timeline={timeline} utteredEventIds={uttered} />
        </div>
      </div>

      {openPortals.map((ref, index) => (
        <StorylinePortal
          elementRef={ref}
          key={ref}
          stackIndex={index}
          variableSamples={runMeta?.variableSamples}
          variableTick={variableTick}
        />
      ))}

      {runMeta && provenancePanel.open ? <ProvenancePanel meta={runMeta} onClose={provenancePanel.close} /> : null}

      <ScrubBar
        firstTick={spatialTickSpan.firstTick}
        lastTick={spatialTickSpan.lastTick}
        onPresentationTickChange={setPresentationTick}
        presentationTickAtCursor={presentationTickAtCursor}
        seedSpreadEventIds={spreadDotIds}
        tickDurationMs={worldTrace?.tick_duration_ms}
      />
    </main>
  );
}
