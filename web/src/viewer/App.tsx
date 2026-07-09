import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { SkinResponse, ViewerDerivedWorld, ViewerEvent, ViewerNode, ViewerState, ViewerWorldErrorResponse, ViewerWorldResponse } from "./types.js";
import { AsciiMap } from "./AsciiMap.js";
import { RenderSettingsPanel } from "./RenderSettingsPanel.js";
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
const sceneTickThrottleMs = 220;

export const SimfileViewerApp = () => {
  const [state, setState] = useState<ViewerState | null>(null);
  const [skins, setSkins] = useState<SkinResponse | null>(null);
  const [world, setWorld] = useState<ViewerDerivedWorld | null>(null);
  const [worldLoadError, setWorldLoadError] = useState<ViewerWorldErrorResponse | Error | string | null>(null);
  const [events, setEvents] = useState<ViewerEvent[]>([]);
  const [tick, setTick] = useState(0);
  const [runName, setRunName] = useState("loading");
  const [selectionId, setSelectionId] = useState("");
  const [skinId, setSkinId] = useState(viewerSkins[0]!.id);
  const [renderSettings, setRenderSettings] = useState(defaultRenderSettings);
  const sceneRenderSettings = useDeferredValue(renderSettings);
  const pendingTickRef = useRef<number | null>(null);
  const tickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSceneTickRef = useRef(0);

  useEffect(() => {
    void fetchJson<ViewerState>("/api/state").then(setState);
    void fetchJson<SkinResponse>("/api/skins").then(setSkins);
    void fetchJson<ViewerWorldResponse>("/api/world")
      .then((response) => {
        const nextWorld = buildViewerWorld(response.trace);
        setWorld(nextWorld);
        setRunName(response.run_name || response.trace.run_name || response.run_id);
        setWorldLoadError(null);
        setSelectionId((current) => current || nextWorld.nodes[1]?.id || nextWorld.nodes[0]?.id || "");
      })
      .catch((error: unknown) => {
        setWorldLoadError(normalizeWorldError(error));
      });

    const flushTick = () => {
      tickTimerRef.current = null;
      const nextTick = pendingTickRef.current;
      pendingTickRef.current = null;
      if (typeof nextTick === "number") {
        lastSceneTickRef.current = performance.now();
        setTick(nextTick);
      }
    };

    const scheduleSceneTick = (nextTick: number) => {
      pendingTickRef.current = nextTick;
      if (tickTimerRef.current !== null) {
        return;
      }
      const elapsed = performance.now() - lastSceneTickRef.current;
      const wait = Math.max(0, sceneTickThrottleMs - elapsed);
      tickTimerRef.current = setTimeout(flushTick, wait);
    };

    const stream = new EventSource("/api/events");
    stream.onmessage = (message) => {
      const event = JSON.parse(message.data) as ViewerEvent;
      if (event.type === "sim.tick" && typeof event.tick === "number") {
        scheduleSceneTick(event.tick);
      }
      startTransition(() => {
        setEvents((current) => [event, ...current].slice(0, 16));
      });
    };
    return () => {
      stream.close();
      if (tickTimerRef.current !== null) {
        clearTimeout(tickTimerRef.current);
      }
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
  const statusSubtitle = `${state?.mode ?? "loading"} · tick ${tick}`;
  const streamLabel = state?.mode === "live" ? "heartbeat stream connected." : "replay clock connected.";

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
            <AsciiMap
              nodes={world.nodes}
              onSelect={setSelectionId}
              renderSettings={sceneRenderSettings}
              roomPaths={world.roomPaths}
              rooms={world.roomGeometries}
              selectedNode={selectedNode}
              selectedSkin={selectedSkin}
            />
          </Panel>

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
          <Panel title="DETAIL" count={selectedNode.kind.toUpperCase()}>
            <div className="detail-head">
              <p>{selectedNode.label}</p>
              <span>{selectedNode.value}</span>
            </div>
            <DetailRow label="scope" value={selectedNode.scope} />
            <DetailRow label="status" value={selectedNode.subtitle} />
            <DetailRow label="scene" value={selectedNode.scene.map((value) => value.toFixed(2)).join(", ")} />
            <p className="detail-copy">{selectedNode.detail}</p>
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

function Panel({ children, count, title }: {
  children: ReactNode;
  count?: ReactNode;
  title: string;
}) {
  return (
    <section className="panel">
      <div className="panel-header">
        <span>[ {title} ]</span>
        {count !== undefined ? <span>{count}</span> : null}
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

function NodeButton({ active, node, onSelect }: {
  active: boolean;
  node: ViewerNode;
  onSelect: (id: string) => void;
}) {
  return (
    <button className={active ? "active" : ""} onClick={() => onSelect(node.id)} type="button">
      <span className="row-main">
        <span className="marker">{active ? ">" : node.kind === "agent" ? "●" : "·"}</span>
        <span className="row-text">
          <span>{node.label}</span>
          <small>{node.subtitle}</small>
        </span>
      </span>
      <span className="row-trail">{node.value}</span>
    </button>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-row">
      <span>{label} :</span>
      <span>{value}</span>
    </div>
  );
}

function EventRow({ actor, detail, target, time, type }: {
  actor: string;
  detail: string;
  target: string;
  time: string;
  type: string;
}) {
  return (
    <div className="event-row">
      <span>[{time}]</span>
      <span>[{type}]</span>
      <strong>{actor}</strong>
      <span>→</span>
      <span>{target}</span>
      <em>{detail}</em>
    </div>
  );
}
