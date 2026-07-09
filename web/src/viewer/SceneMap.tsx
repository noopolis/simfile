import {
  GlyphMapControls,
  GlyphOrbitControls,
  GlyphPerspectiveCamera,
  GlyphScene,
} from "@glyphcss/react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import type { RoomGeometry, RoomPath, ViewerNode, ViewerPresenceEvent } from "./types.js";
import { CameraFocus, cameraFocusForNode } from "./CameraFocus.js";
import { AgentAvatar, CorridorMeshes, RoomMeshes, SignalMesh } from "./SceneGeometry.js";
import { createAgentPlacements } from "./sceneMotion.js";
import type { AgentPlacement } from "./sceneMotion.js";
import { AgentSceneLabels, StaticSceneLabels } from "./SceneLabels.js";
import type { RenderSettings } from "./renderSettings.js";
import type { ViewerSkin } from "./worldModel.js";
import { createRoomLayout } from "./roomLayout.js";
import { useAvatarModel } from "./avatarModel.js";

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
  tick: number;
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
  tick,
}: SceneMapProps) {
  const signalNodes = useMemo(() => nodes.filter((node) => node.kind !== "room" && node.kind !== "agent"), [nodes]);
  const roomLayout = useMemo(() => createRoomLayout(rooms, roomPaths, renderSettings.roomScale), [renderSettings.roomScale, roomPaths, rooms]);
  const agentPlacements = useMemo(
    () => createAgentPlacements({
      nodes,
      paths: roomLayout.paths,
      presenceByAgent,
      roomScale: renderSettings.roomScale,
      rooms: roomLayout.rooms,
      tick,
    }),
    [nodes, presenceByAgent, renderSettings.roomScale, roomLayout.paths, roomLayout.rooms, tick],
  );
  const mapStageRef = useRef<HTMLDivElement | null>(null);
  const [baseMode, setBaseMode] = useState<CameraMode>("orbit");
  const [commandPan, setCommandPan] = useState(false);
  const [stageSize, setStageSize] = useState<StageSize>({ height: 0, width: 0 });
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
  const interactiveDownscale = Math.max(1, Math.min(4, Math.round(renderSettings.density)));

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

  return (
    <div className="map-stage" ref={mapStageRef}>
      <SeededPerspectiveCamera selectedNode={selectedNode} selectedSkin={selectedSkin}>
        <GlyphScene
          mode="solid"
          cols={renderGrid.cols}
          rows={renderGrid.rows}
          cellAspect={2}
          interactiveDownscale={interactiveDownscale}
          style={glyphStyle}
        >
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
            agentPlacements={agentPlacements}
            onSelect={onSelect}
            renderSettings={renderSettings}
            selectedNodeId={selectedNode.id}
            selectedSkin={selectedSkin}
          />
        </GlyphScene>
      </SeededPerspectiveCamera>
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
        <span>{renderGrid.cols}x{renderGrid.rows} cells</span>
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
    && previous.selectedNode.id === next.selectedNode.id
    && previous.selectedSkin.id === next.selectedSkin.id
    && previous.tick === next.tick;
}

const StaticSceneLayer = memo(function StaticSceneLayer({
  onSelect,
  paths,
  renderSettings,
  rooms,
  selectedNodeId,
  selectedSkin,
  signalNodes,
}: {
  onSelect: (id: string) => void;
  paths: RoomPath[];
  renderSettings: RenderSettings;
  rooms: RoomGeometry[];
  selectedNodeId: string;
  selectedSkin: ViewerSkin;
  signalNodes: ViewerNode[];
}) {
  return (
    <>
      {paths.map((path) => (
        <CorridorMeshes
          key={`${selectedSkin.id}:${path.id}`}
          path={path}
          renderSettings={renderSettings}
          skin={selectedSkin}
        />
      ))}
      {rooms.map((room) => (
        <RoomMeshes
          key={`${selectedSkin.id}:${room.id}`}
          paths={paths}
          renderSettings={renderSettings}
          room={room}
          selected={selectedNodeId === room.node.id}
          skin={selectedSkin}
        />
      ))}
      {signalNodes.map((node) => <SignalMesh key={`${selectedSkin.id}:${node.id}`} node={node} skin={selectedSkin} />)}
      {renderSettings.showLabels ? (
        <StaticSceneLabels
          onSelect={onSelect}
          renderSettings={renderSettings}
          rooms={rooms}
          selectedNodeId={selectedNodeId}
          signalNodes={signalNodes}
        />
      ) : null}
    </>
  );
});

const AgentSceneLayer = memo(function AgentSceneLayer({
  agentPlacements,
  onSelect,
  renderSettings,
  selectedNodeId,
  selectedSkin,
}: {
  agentPlacements: AgentPlacement[];
  onSelect: (id: string) => void;
  renderSettings: RenderSettings;
  selectedNodeId: string;
  selectedSkin: ViewerSkin;
}) {
  const avatarPolygons = useAvatarModel();

  return (
    <>
      {agentPlacements.map((placement) => (
        <AgentAvatar
          key={`${selectedSkin.id}:${placement.node.id}`}
          placement={placement}
          polygons={avatarPolygons}
          renderSettings={renderSettings}
          selected={selectedNodeId === placement.node.id}
          skin={selectedSkin}
        />
      ))}
      {renderSettings.showLabels
        ? (
          <AgentSceneLabels
            agentPlacements={agentPlacements}
            onSelect={onSelect}
            renderSettings={renderSettings}
            selectedNodeId={selectedNodeId}
          />
        )
        : null}
    </>
  );
});

function SeededPerspectiveCamera({ children, selectedNode, selectedSkin }: {
  children: ReactNode;
  selectedNode: ViewerNode;
  selectedSkin: ViewerSkin;
}) {
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    setSeeded(true);
  }, []);

  return (
    <GlyphPerspectiveCamera
      center={seeded ? undefined : selectedNode.camera}
      className="glyph-camera"
      distance={seeded ? undefined : selectedSkin.camera.distance}
      rotX={seeded ? undefined : selectedSkin.camera.rotX}
      rotY={seeded ? undefined : selectedSkin.camera.rotY}
      zoom={seeded ? undefined : selectedSkin.camera.zoom}
    >
      {children}
    </GlyphPerspectiveCamera>
  );
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
