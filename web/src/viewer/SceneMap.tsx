import {
  GlyphMapControls,
  GlyphOrbitControls,
  GlyphScene,
} from "@glyphcss/react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

import type { RoomGeometry, RoomPath, ViewerNode, ViewerPresenceEvent, ViewerSpatialSample } from "./types.js";
import { CameraFocus, cameraFocusForNode } from "./CameraFocus.js";
import {
  DynamicGlyphScene,
  readDynamicRendererConfig,
  scaledRenderGrid,
} from "./DynamicGlyphScene.js";
import { DynamicSceneOverlay } from "./DynamicSceneOverlay.js";
import type { DynamicSceneEntity } from "./DynamicSceneOverlay.js";
import { createAgentPlacements } from "./sceneMotion.js";
import {
  createGlyphLayerRegistry,
  SeededPerspectiveCamera,
  StaticGlyphLayerCapture,
} from "./SceneCamera.js";
import { AgentSceneLayer, StaticSceneLayer } from "./SceneLayers.js";
import type { RenderSettings } from "./renderSettings.js";
import type { ViewerSkin } from "./worldModel.js";
import { createRoomLayout } from "./roomLayout.js";
import { applySpatialSamplesToNodes, applySpatialSamplesToPlacements } from "./spatialSceneModel.js";
import {
  WorldMapRendererHost,
} from "./WorldMapRendererHost.js";
import { selectWorldMapRenderer } from "./worldMapRendererCatalog.js";
import { buildWorldMapRendererFrame } from "./worldMapRendererFrame.js";

type CameraMode = "orbit" | "pan";

const baseGlyphWidthPx = 4.8;
const baseGlyphHeightPx = 8.8;

interface StageSize {
  height: number;
  width: number;
}

interface RenderGrid {
  cols: number;
  rows: number;
}

interface SceneMapProps {
  nodes: ViewerNode[];
  onSelect: (id: string) => void;
  onToggleLabels: () => void;
  presenceByAgent: Record<string, ViewerPresenceEvent[]>;
  renderSettings: RenderSettings;
  roomPaths: RoomPath[];
  rooms: RoomGeometry[];
  selectedNode: ViewerNode;
  selectedSkin: ViewerSkin;
  spatialSamples?: ViewerSpatialSample[];
  tick: number;
  tickDurationMs: number;
}

export const SceneMap = memo(function SceneMap({
  nodes,
  onSelect,
  onToggleLabels,
  presenceByAgent,
  renderSettings,
  roomPaths,
  rooms,
  selectedNode,
  selectedSkin,
  spatialSamples = [],
  tick,
  tickDurationMs,
}: SceneMapProps) {
  const sampledNodes = useMemo(
    () => applySpatialSamplesToNodes(nodes, spatialSamples, tick, tickDurationMs),
    [nodes, spatialSamples, tick, tickDurationMs],
  );
  const dynamicIds = useMemo(
    () => new Set(spatialSamples.flatMap((sample) =>
      sample.objects?.map((object) => object.id) ?? [])),
    [spatialSamples],
  );
  const signalNodes = useMemo(
    () => nodes.filter((node) =>
      node.kind !== "room" && node.kind !== "agent" && !dynamicIds.has(node.id)),
    [dynamicIds, nodes],
  );
  const roomLayout = useMemo(() => createRoomLayout(rooms, roomPaths, renderSettings.roomScale), [renderSettings.roomScale, roomPaths, rooms]);
  const agentPlacements = useMemo(() => applySpatialSamplesToPlacements(
    createAgentPlacements({
      nodes: sampledNodes,
      paths: roomLayout.paths,
      presenceByAgent,
      roomScale: renderSettings.roomScale,
      rooms: roomLayout.rooms,
      tick,
    }),
    spatialSamples,
    tick,
    tickDurationMs,
  ), [presenceByAgent, renderSettings.roomScale, roomLayout.paths, roomLayout.rooms, sampledNodes, spatialSamples, tick, tickDurationMs]);
  const staticAgentPlacements = useMemo(
    () => agentPlacements.filter((placement) => !dynamicIds.has(placement.node.id)),
    [agentPlacements, dynamicIds],
  );
  const dynamicAgentPlacements = useMemo(
    () => agentPlacements.filter((placement) => dynamicIds.has(placement.node.id)),
    [agentPlacements, dynamicIds],
  );
  const dynamicSignalNodes = useMemo(
    () => sampledNodes.filter((node) =>
      node.kind !== "room" && node.kind !== "agent" && dynamicIds.has(node.id)),
    [dynamicIds, sampledNodes],
  );
  const dynamicEntities = useMemo<DynamicSceneEntity[]>(() => [
    ...dynamicAgentPlacements
      .map((placement) => ({
        at: placement.position,
        id: placement.node.id,
        kind: "agent" as const,
        label: placement.node.label,
        selected: selectedNode.id === placement.node.id,
      })),
    ...dynamicSignalNodes
      .map((node) => ({
        at: node.scene,
        id: node.id,
        kind: "signal" as const,
        label: node.label,
        selected: selectedNode.id === node.id,
      })),
  ], [dynamicAgentPlacements, dynamicSignalNodes, selectedNode.id]);
  const mapStageRef = useRef<HTMLDivElement | null>(null);
  const [baseMode, setBaseMode] = useState<CameraMode>("orbit");
  const [commandPan, setCommandPan] = useState(false);
  const [rendererFitRevision, setRendererFitRevision] = useState(0);
  const [stageSize, setStageSize] = useState<StageSize>({ height: 0, width: 0 });
  const dynamicConfig = useMemo(readDynamicRendererConfig, []);
  const glyphLayerRegistry = useRef(createGlyphLayerRegistry()).current;
  const mode = commandPan ? "pan" : baseMode;
  const renderGrid = useMemo(
    () => computeRenderGrid(stageSize, renderSettings.density),
    [stageSize, renderSettings.density],
  );
  const cameraFocus = useMemo(
    () => cameraFocusForNode(selectedNode, renderSettings, selectedSkin, roomLayout.rooms),
    [renderSettings, roomLayout.rooms, selectedNode, selectedSkin],
  );
  const glyphStyle = useMemo(() => createGlyphStyle(renderSettings.density), [renderSettings.density]);
  const dynamicGrid = useMemo(
    () => scaledRenderGrid(renderGrid, dynamicConfig.scale),
    [dynamicConfig.scale, renderGrid],
  );
  const dynamicGlyphStyle = useMemo(
    () => createGlyphStyle(renderSettings.density / dynamicConfig.scale),
    [dynamicConfig.scale, renderSettings.density],
  );
  const interactiveDownscale = Math.max(1, Math.min(4, Math.round(renderSettings.density)));
  const rendererFrame = useMemo(() => buildWorldMapRendererFrame({
    nodes,
    onSelect,
    selectedNodeId: selectedNode.id,
    spatialSamples,
    tick,
    tickDurationMs,
  }), [
    nodes,
    onSelect,
    selectedNode.id,
    spatialSamples,
    tick,
    tickDurationMs,
  ]);
  const worldMapRenderer = useMemo(
    () => selectWorldMapRenderer(rendererFrame),
    [rendererFrame],
  );

  useEffect(() => {
    const target = globalThis as typeof globalThis & {
      __SIMFILE_PLAYBACK_DIAGNOSTICS__?: Record<string, number | boolean>;
    };
    const shared = target.__SIMFILE_PLAYBACK_DIAGNOSTICS__ ??= {};
    shared.dynamicRendererGlyph = dynamicConfig.renderer === "glyph";
    shared.dynamicScale = dynamicConfig.scale;
  }, [dynamicConfig]);

  useEffect(() => {
    const element = mapStageRef.current;
    if (!element) {
      return;
    }

    const syncSize = () => {
      const rect = element.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      setStageSize((current) => current.width === width && current.height === height ? current : { height, width });
    };

    syncSize();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", syncSize);
      return () => window.removeEventListener("resize", syncSize);
    }

    const observer = new ResizeObserver(syncSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Meta") {
        setCommandPan(true);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Meta") {
        setCommandPan(false);
        setBaseMode("orbit");
      }
    };
    const onBlur = () => {
      setCommandPan(false);
      setBaseMode("orbit");
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  if (worldMapRenderer) {
    return (
      <div className="map-stage fixture-renderer-stage" ref={mapStageRef}>
        <WorldMapRendererHost
          fitRevision={rendererFitRevision}
          frame={rendererFrame}
          renderer={worldMapRenderer}
        />
        <div className="map-controls-bar" aria-label="World renderer">
          <button
            onClick={() => setRendererFitRevision((revision) => revision + 1)}
            type="button"
          >
            reset / fit
          </button>
          <span>{worldMapRenderer.id}</span>
          <span>broadcast isometric · authoritative public replay</span>
        </div>
      </div>
    );
  }

  return (
    <div className="map-stage" ref={mapStageRef}>
      <SeededPerspectiveCamera
        className="glyph-camera static-glyph-camera"
        selectedNode={selectedNode}
        selectedSkin={selectedSkin}
      >
        <GlyphScene
          mode="solid"
          cols={renderGrid.cols}
          rows={renderGrid.rows}
          cellAspect={2}
          interactiveDownscale={interactiveDownscale}
          style={glyphStyle}
        >
          <StaticGlyphLayerCapture registry={glyphLayerRegistry} />
          <CameraFocus focus={cameraFocus} />
          {mode === "pan" ? <GlyphMapControls drag wheel /> : <GlyphOrbitControls clampPitch drag wheel />}
          <StaticSceneLayer
            onSelect={onSelect}
            paths={roomLayout.paths}
            renderSettings={renderSettings}
            rooms={roomLayout.rooms}
            selectedNodeId={selectedNode.id}
            selectedSkin={selectedSkin}
            signalNodes={signalNodes}
          />
          <AgentSceneLayer
            agentPlacements={staticAgentPlacements}
            onSelect={onSelect}
            renderSettings={renderSettings}
            selectedNodeId={selectedNode.id}
            selectedSkin={selectedSkin}
          />
          {dynamicConfig.renderer === "glyph" ? (
            <AgentSceneLayer
              agentPlacements={dynamicAgentPlacements}
              onSelect={onSelect}
              renderSettings={renderSettings}
              selectedNodeId={selectedNode.id}
              selectedSkin={selectedSkin}
              showModels={false}
            />
          ) : (
            <DynamicSceneOverlay entities={dynamicEntities} onSelect={onSelect} />
          )}
        </GlyphScene>
      </SeededPerspectiveCamera>
      {dynamicConfig.renderer === "glyph" ? (
        <DynamicGlyphScene
          agentPlacements={dynamicAgentPlacements}
          config={dynamicConfig}
          grid={dynamicGrid}
          registry={glyphLayerRegistry}
          renderSettings={renderSettings}
          selectedNode={selectedNode}
          selectedSkin={selectedSkin}
          signalNodes={dynamicSignalNodes}
          style={dynamicGlyphStyle}
        />
      ) : null}
      <div className="map-controls-bar" aria-label="Camera and display mode">
        <button
          aria-pressed={mode === "orbit"}
          className={mode === "orbit" ? "selected" : ""}
          onClick={() => setBaseMode("orbit")}
          type="button"
        >
          orbit
        </button>
        <button
          aria-pressed={mode === "pan"}
          className={mode === "pan" ? "selected" : ""}
          onClick={() => setBaseMode("pan")}
          type="button"
        >
          pan
        </button>
        <button
          aria-pressed={renderSettings.showLabels}
          className={renderSettings.showLabels ? "selected" : ""}
          onClick={onToggleLabels}
          type="button"
        >
          labels
        </button>
        <span>
          {renderGrid.cols}x{renderGrid.rows} cells · dynamic{" "}
          {dynamicConfig.renderer === "glyph"
            ? `GlyphCSS ${dynamicConfig.scale}x`
            : "DOM fallback"}
        </span>
        <span>{commandPan ? "⌘ pan override" : "hold ⌘ for pan"}</span>
      </div>
    </div>
  );
}, areSceneMapPropsEqual);

function areSceneMapPropsEqual(previous: SceneMapProps, next: SceneMapProps): boolean {
  return previous.nodes === next.nodes
    && previous.onSelect === next.onSelect
    && previous.onToggleLabels === next.onToggleLabels
    && previous.presenceByAgent === next.presenceByAgent
    && previous.renderSettings === next.renderSettings
    && previous.roomPaths === next.roomPaths
    && previous.rooms === next.rooms
    && previous.spatialSamples === next.spatialSamples
    && previous.selectedNode.id === next.selectedNode.id
    && previous.selectedSkin.id === next.selectedSkin.id
    && previous.tick === next.tick
    && previous.tickDurationMs === next.tickDurationMs;
}

function computeRenderGrid(stageSize: StageSize, density: number): RenderGrid {
  const baseCols = stageSize.width > 0 ? stageSize.width / baseGlyphWidthPx : 220;
  const baseRows = stageSize.height > 0 ? stageSize.height / baseGlyphHeightPx : 82;
  return {
    cols: clampInt(Math.round(baseCols * density), 80, 1200),
    rows: clampInt(Math.round(baseRows * density), 36, 520),
  };
}

function createGlyphStyle(density: number): CSSProperties {
  const cellHeight = baseGlyphHeightPx / density;
  return {
    fontSize: `${cellHeight}px`,
    lineHeight: `${cellHeight}px`,
  };
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
