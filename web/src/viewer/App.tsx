import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { SkinResponse, ViewerDerivedWorld, ViewerEvent, ViewerNode, ViewerState, ViewerWorldErrorResponse, ViewerWorldResponse } from "./types.js";
import { EventRow, NodeButton, Panel } from "./AppRows.js";
import { SceneMap } from "./SceneMap.js";
import { NodeDetails } from "./NodeDetails.js";
import { RenderSettingsPanel } from "./RenderSettingsPanel.js";
import { SpatialPlaybackControls } from "./SpatialPlaybackControls.js";
import { WorldHud } from "./WorldHud.js";
import { replayModeErrorHeadline, replayMissingArtifactMessage, isReplayWorldError } from "./traceFixture.js";
import { defaultRenderSettings } from "./renderSettings.js";
import { buildViewerWorld, viewerSkins } from "./worldModel.js";

const fetchJson = async <T,>(url: string): Promise<T> => {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    const fallbackError = `GET ${url} failed with ${response.status}`;
    let parsed: unknown;
    try {
      parsed = body.length > 0 ? JSON.parse(body) : undefined;
    } catch {
      throw new Error(fallbackError);
    }
    if (
      typeof parsed === "object"
      && parsed !== null
      && "error" in parsed
    ) {
      throw parsed as ViewerWorldErrorResponse;
    }
    throw new Error(fallbackError);
  }
  return response.json() as Promise<T>;
};

const formatWorldError = (error: unknown): string => {
  if (!isReplayWorldError(error)) {
    if (typeof error === "object" && error !== null && "error" in error && typeof (error as ViewerWorldErrorResponse).error === "string") {
      return (error as ViewerWorldErrorResponse).error;
    }
    return error instanceof Error ? error.message : typeof error === "string" ? error : "Failed to load run trace from /api/world.";
  }

  const missingArtifacts = error.missing_artifacts?.length ? error.missing_artifacts : [];
  if (missingArtifacts.length > 0 && error.source_path !== undefined) {
    return replayMissingArtifactMessage(error.source_path, missingArtifacts);
  }
  return error.error;
};

const normalizeWorldError = (error: unknown): ViewerWorldErrorResponse | Error | string => {
  if (isReplayWorldError(error) || (typeof error === "object" && error !== null && "error" in error && typeof (error as ViewerWorldErrorResponse).error === "string")) {
    return error as ViewerWorldErrorResponse;
  }
  if (error instanceof Error) return error;
  if (typeof error === "string") return error;
  return "failed to load viewer trace";
};

const worldErrorHeadline = (error: unknown): string =>
  isReplayWorldError(error) ? replayModeErrorHeadline : "VIEWER TRACE ERROR";
const nodeGroups: Array<{ label: string; kinds: ViewerNode["kind"][] }> = [
  { label: "ROOMS", kinds: ["room"] },
  { label: "AGENTS", kinds: ["agent"] },
  { label: "SIGNALS", kinds: ["variable", "marker", "probe"] },
];
export const SimfileViewerApp = () => {
  const [state, setState] = useState<ViewerState | null>(null);
  const [skins, setSkins] = useState<SkinResponse | null>(null);
  const [world, setWorld] = useState<ViewerDerivedWorld | null>(null);
  const [worldLoadError, setWorldLoadError] = useState<ViewerWorldErrorResponse | Error | string | null>(null);
  const [events, setEvents] = useState<ViewerEvent[]>([]);
  const [tick, setTick] = useState(0);
  const [runId, setRunId] = useState("");
  const [runName, setRunName] = useState("loading");
  const [playbackStatus, setPlaybackStatus] =
    useState<"live" | "completed" | "failed">("live");
  const [selectionId, setSelectionId] = useState("");
  const [skinId, setSkinId] = useState(viewerSkins[0]!.id);
  const [renderSettings, setRenderSettings] = useState(defaultRenderSettings);
  const sceneRenderSettings = useDeferredValue(renderSettings);
  const hasSpatialSamplesRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    let stream: EventSource | null = null;
    void fetchJson<ViewerState>("/api/state").then(setState);
    void fetchJson<SkinResponse>("/api/skins").then(setSkins);
    const refreshWorld = () => fetchJson<ViewerWorldResponse>("/api/world")
      .then((response) => {
        if (disposed) return null;
        const nextWorld = buildViewerWorld(response.trace);
        hasSpatialSamplesRef.current = nextWorld.spatialSamples.length > 0;
        setWorld(nextWorld);
        setRunId(response.run_id);
        setRunName(response.run_name || response.trace.run_name || response.run_id);
        setPlaybackStatus(response.trace.playback_status ?? "live");
        setWorldLoadError(null);
        setSelectionId((current) =>
          current || nextWorld.nodes.find((node) => node.kind === "room")?.id || nextWorld.nodes[0]?.id || "");
        return response.trace.playback_status ?? "live";
      })
      .catch((error: unknown) => {
        if (!disposed) setWorldLoadError(normalizeWorldError(error));
        return null;
      });

    const connectStream = () => {
      if (disposed || stream !== null) return;
      stream = new EventSource("/api/events");
      stream.onmessage = (message) => {
        const event = JSON.parse(message.data) as ViewerEvent;
        if (event.type === "sim.tick" && typeof event.tick === "number") {
          if (!hasSpatialSamplesRef.current) setTick(event.tick);
          void refreshWorld().then((status) => {
            if (status !== null && status !== "live") {
              stream?.close();
              stream = null;
            }
          });
        }
        startTransition(() => {
          setEvents((current) => [event, ...current].slice(0, 16));
        });
      };
    };

    void refreshWorld().then((status) => {
      if (status === "live") connectStream();
    });

    return () => {
      disposed = true;
      stream?.close();
      stream = null;
    };
  }, []);

  useEffect(() => {
    if (!world) {
      return;
    }
    if (!world.nodes.some((node) => node.id === selectionId)) {
      setSelectionId(world.nodes[0]?.id ?? "");
    }
  }, [selectionId, world]);

  const selectedNode = useMemo(
    () => world?.nodes.find((node) => node.id === selectionId) ?? world?.nodes[0] ?? null,
    [selectionId, world],
  );
  const selectedSkin = useMemo(
    () => viewerSkins.find((skin) => skin.id === skinId) ?? viewerSkins[0]!,
    [skinId],
  );
  const updateRenderSettings = useCallback((settings: typeof defaultRenderSettings) => {
    startTransition(() => setRenderSettings(settings));
  }, []);
  const skinOptions = skins?.options.length
    ? viewerSkins.filter((skin) => skins.options.some((option) => option.id === skin.id))
    : viewerSkins;
  const livePlayback = state?.mode === "live" && playbackStatus === "live";
  const presentationMode = state?.mode === "live" && playbackStatus !== "live"
    ? `replay ${playbackStatus}`
    : state?.mode ?? "loading";
  const statusSubtitle = `${presentationMode} · tick ${
    Number.isInteger(tick) ? tick : tick.toFixed(1)
  }`;
  const streamLabel = livePlayback
    ? "heartbeat stream connected."
    : "replay clock connected.";

  if (worldLoadError !== null) {
    const replayError = isReplayWorldError(worldLoadError) ? worldLoadError : null;
    const missingArtifacts = replayError?.missing_artifacts?.length ?? 0;
    return (
      <main className={`viewer-shell ${selectedSkin.className}`}>
        <header className="topbar">
          <div className="topbar-title">
            <span className="sigil">▦</span>
            <span className="brand">SIMFILE</span>
            <span className="version">v0.1</span>
            <span className="run-name">{runName}</span>
            <span className="subtitle">replay unavailable</span>
          </div>
        </header>
        <section className="console-grid">
          <section className="main-column">
            <Panel title={worldErrorHeadline(worldLoadError)} count="error">
              <p className="detail-copy">{formatWorldError(worldLoadError)}</p>
              {missingArtifacts ? (
                <p className="detail-copy">
                  Required artifacts:
                  <br />
                  {replayError?.missing_artifacts?.join(", ")}
                </p>
              ) : null}
            {state?.mode === "replay" || replayError?.mode === "replay" ? (
              <p className="detail-copy">
                No synthetic fallback trace is available in replay mode.
              </p>
            ) : null}
              <p className="detail-copy">
                Replay depends on a sealed run directory artifact bundle in <code>sourcePath</code>.
              </p>
            </Panel>
          </section>
        </section>
      </main>
    );
  }

  if (!world || !selectedNode) {
    return (
      <main className={`viewer-shell ${selectedSkin.className}`}>
        <header className="topbar">
          <div className="topbar-title">
            <span className="sigil">▦</span>
            <span className="brand">SIMFILE</span>
            <span className="version">v0.1</span>
            <span className="run-name">{runName}</span>
            <span className="subtitle">loading run trace</span>
          </div>
        </header>
      </main>
    );
  }

  return (
    <main className={`viewer-shell ${selectedSkin.className}`}>
      <header className="topbar">
        <div className="topbar-title">
          <span className="sigil">▦</span>
          <span className="brand">SIMFILE</span>
          <span className="version">v0.1</span>
          <span className="run-name">{runName}</span>
          <span className="subtitle">{statusSubtitle}</span>
        </div>
        <div className="topbar-actions">
          <label className="skin-select">
            <span>skin</span>
            <select
              aria-label="Viewer skin"
              onChange={(event) => setSkinId(event.target.value)}
              value={skinId}
            >
              {skinOptions.map((skin) => (
                <option key={skin.id} value={skin.id}>{skin.label}</option>
              ))}
            </select>
          </label>
          <span className="stream-status"><span /> {streamLabel}</span>
        </div>
      </header>

      <section className="console-grid">
        <aside className="sidebar">
          {nodeGroups.map((group) => (
            <Panel key={group.label} title={group.label} count={world.nodes.filter((node) => group.kinds.includes(node.kind)).length}>
              <div className="list">
                {world.nodes
                  .filter((node) => group.kinds.includes(node.kind))
                  .map((node) => (
                    <NodeButton
                      active={node.id === selectedNode.id}
                      key={node.id}
                      node={node}
                      onSelect={setSelectionId}
                    />
                  ))}
              </div>
            </Panel>
          ))}
        </aside>

        <section className="main-column">
          <Panel title="WORLD MAP" count={`${world.nodes.length} objects · ${world.roomPaths.length} paths`}>
            <SceneMap
              nodes={world.nodes}
              onSelect={setSelectionId}
              onToggleLabels={() => setRenderSettings((current) => ({ ...current, showLabels: !current.showLabels }))}
              renderSettings={sceneRenderSettings}
              roomPaths={world.roomPaths}
              rooms={world.roomGeometries}
              selectedNode={selectedNode}
              selectedSkin={selectedSkin}
              presenceByAgent={world.presenceByAgent}
              spatialSamples={world.spatialSamples}
              tick={tick}
              tickDurationMs={world.tickDurationMs}
            />
          </Panel>

          <WorldHud
            inspectionsByNode={world.inspectionsByNode}
            inspectionSamples={world.inspectionSamples}
            nodes={world.nodes}
            onSelect={setSelectionId}
            selectedNodeId={selectedNode.id}
            spatialSamples={world.spatialSamples}
            tick={tick}
          />

          <SpatialPlaybackControls
            live={livePlayback}
            onTick={setTick}
            runId={runId}
            samples={world.spatialSamples}
            tickDurationMs={world.tickDurationMs}
          />

          <div className="focus-rail" aria-label="Focus targets">
            {world.nodes.map((node) => (
              <button
                className={node.id === selectedNode.id ? "selected" : ""}
                key={node.id}
                onClick={() => setSelectionId(node.id)}
                type="button"
              >
                <span>{node.kind}</span>
                {node.label}
              </button>
            ))}
          </div>
        </section>

        <aside className="inspector">
          <Panel
            title={selectedNode.kind === "agent" ? "AGENT INSPECTOR" : "DETAIL"}
            count={selectedNode.kind.toUpperCase()}
          >
            <NodeDetails
              inspection={world.inspectionsByNode[selectedNode.id]}
              inspectionSamples={world.inspectionSamples}
              node={selectedNode}
              spatialSamples={world.spatialSamples}
              tick={tick}
            />
          </Panel>

          <Panel title="EVENTS" count={`${world.ledgerRows.length + events.length} rows`}>
            <div className="event-list">
              {events.slice(0, 4).map((event, index) => (
                <EventRow
                  actor="@viewer"
                  detail={event.message ?? event.at ?? "event"}
                  key={`${event.type}:${event.tick ?? index}`}
                  target="stream"
                  time={event.tick ? `t+${event.tick}` : "now"}
                  type={event.type.toUpperCase()}
                />
              ))}
              {world.ledgerRows.map((row) => (
                <EventRow key={`${row.time}:${row.type}`} {...row} />
              ))}
            </div>
          </Panel>

          <Panel title="VISUALS" count="live">
            <RenderSettingsPanel onChange={updateRenderSettings} settings={renderSettings} />
          </Panel>
        </aside>
      </section>

      <footer className="statusbar">
        <span>source {state?.sourcePath ?? "."}</span>
        <span>state {state?.statePath ?? "run record"}</span>
        <span>selected {selectedNode.scope}</span>
      </footer>
    </main>
  );
};
