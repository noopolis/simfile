import { useGlyphCamera, useGlyphSceneContext } from "@glyphcss/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

import type { RoomGeometry, ViewerNode } from "./types.js";
import type { RenderSettings } from "./renderSettings.js";
import type { AgentPlacement, Vec3 } from "./sceneMotion.js";

interface SceneLabel {
  at: Vec3;
  className: string;
  id: string;
  onSelect?: () => void;
  secondary?: string;
  title: string;
}

interface LabelProjection {
  hidden: boolean;
  left: number;
  top: number;
  zIndex: number;
}

export function StaticSceneLabels({ onSelect, renderSettings, rooms, selectedNodeId, signalNodes }: {
  onSelect: (id: string) => void;
  renderSettings: RenderSettings;
  rooms: RoomGeometry[];
  selectedNodeId: string;
  signalNodes: ViewerNode[];
}) {
  const labels = useMemo(() => [
    ...rooms.map((room) => ({
      at: roomLabelPosition(room, renderSettings),
      className: `scene-label room ${selectedNodeId === room.node.id ? "selected" : ""}`,
      id: `room:${room.id}`,
      onSelect: () => onSelect(room.node.id),
      secondary: `${room.access.length} access`,
      title: room.node.label,
    })),
    ...signalNodes
      .filter((node) => selectedNodeId === node.id)
      .map((node) => ({
        at: signalLabelPosition(node),
        className: `scene-label ${node.kind} selected`,
        id: `signal:${node.id}`,
        onSelect: () => onSelect(node.id),
        secondary: node.value,
        title: node.label,
      })),
  ], [onSelect, renderSettings, rooms, selectedNodeId, signalNodes]);

  return <ProjectedSceneLabels labels={labels} />;
}

export function AgentSceneLabels({ agentPlacements, onSelect, renderSettings, selectedNodeId }: {
  agentPlacements: AgentPlacement[];
  onSelect: (id: string) => void;
  renderSettings: RenderSettings;
  selectedNodeId: string;
}) {
  const labels = useMemo(() => agentPlacements
    .filter((placement) => agentPlacements.length <= 8 || selectedNodeId === placement.node.id)
    .map((placement) => ({
      at: agentLabelPosition(placement, renderSettings),
      className: `scene-label agent ${placement.moving ? "moving" : ""} ${selectedNodeId === placement.node.id ? "selected" : ""}`,
      id: `agent:${placement.node.id}`,
      onSelect: () => onSelect(placement.node.id),
      secondary: placement.moving ? "moving" : placement.node.value,
      title: placement.node.label,
    })), [agentPlacements, onSelect, renderSettings, selectedNodeId]);

  return <ProjectedSceneLabels labels={labels} />;
}

function ProjectedSceneLabels({ labels }: { labels: SceneLabel[] }) {
  const { cameraRef } = useGlyphCamera();
  const { sceneRef } = useGlyphSceneContext();
  const labelsRef = useRef(labels);
  const signatureRef = useRef("");
  const [projections, setProjections] = useState<Record<string, LabelProjection>>({});
  labelsRef.current = labels;

  const syncProjection = () => {
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (!scene || !camera) {
      return;
    }
    const next = projectLabels(labelsRef.current, scene, camera);
    const signature = projectionSignature(next);
    if (signature !== signatureRef.current) {
      signatureRef.current = signature;
      setProjections(next);
    }
  };

  useLayoutEffect(() => {
    syncProjection();
  });

  useEffect(() => {
    if (labelsRef.current.length === 0) {
      setProjections({});
      return undefined;
    }
    let frame = 0;
    const update = () => {
      syncProjection();
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [cameraRef, labels.length, sceneRef]);

  return (
    <div className="projected-label-layer" aria-label="Map labels">
      {labels.map((label) => (
        <ProjectedLabel key={label.id} label={label} projection={projections[label.id]} />
      ))}
    </div>
  );
}

function ProjectedLabel({ label, projection }: { label: SceneLabel; projection?: LabelProjection }) {
  const style = projectionStyle(projection);
  return label.onSelect ? (
    <button aria-label={`Select ${label.title}`} className={label.className} onClick={label.onSelect} style={style} type="button">
      <LabelContent label={label} />
    </button>
  ) : (
    <div className={label.className} style={style}>
      <LabelContent label={label} />
    </div>
  );
}

function LabelContent({ label }: { label: SceneLabel }) {
  return (
    <>
      <strong>{label.title}</strong>
      {label.secondary ? <span>{label.secondary}</span> : null}
    </>
  );
}

function projectLabels(labels: SceneLabel[], scene: ReturnType<typeof useGlyphSceneContext>["sceneRef"]["current"], camera: ReturnType<typeof useGlyphCamera>["cameraRef"]["current"]) {
  if (!scene || !camera) return {};
  const options = scene.getOptions();
  const outputRect = scene.output.getBoundingClientRect();
  const hostRect = scene.host.getBoundingClientRect();
  const cols = options.cols ?? 80;
  const rows = options.rows ?? 24;
  const cellAspect = options.cellAspect ?? 2;
  const cellWidth = outputRect.width > 0 ? outputRect.width / cols : 8;
  const cellHeight = outputRect.height > 0 ? outputRect.height / rows : 16;
  const metrics = { cellWidth, cellHeight };
  const next: Record<string, LabelProjection> = {};
  for (const label of labels) {
    const [col, row, depth] = camera.project(label.at, cols, rows, cellAspect, metrics);
    const hidden = !Number.isFinite(col) || !Number.isFinite(row) || col < -10 || col > cols + 10 || row < -10 || row > rows + 10;
    next[label.id] = {
      hidden,
      left: outputRect.left - hostRect.left + (col + 0.5) * cellWidth,
      top: outputRect.top - hostRect.top + (row + 0.5) * cellHeight,
      zIndex: Number.isFinite(depth) ? Math.max(1, Math.round(100000 + depth)) : 1,
    };
  }
  return next;
}

function projectionStyle(projection: LabelProjection | undefined): CSSProperties {
  if (!projection || projection.hidden) {
    return { display: "none" };
  }
  return {
    left: `${projection.left}px`,
    top: `${projection.top}px`,
    zIndex: projection.zIndex,
  };
}

function projectionSignature(projections: Record<string, LabelProjection>): string {
  return Object.entries(projections)
    .map(([id, projection]) => `${id}:${projection.hidden ? 1 : 0}:${Math.round(projection.left)}:${Math.round(projection.top)}:${projection.zIndex}`)
    .join("|");
}

function roomLabelPosition(room: RoomGeometry, renderSettings: RenderSettings): Vec3 {
  return [
    room.center[0],
    room.center[1] - room.size[1] * renderSettings.roomScale * 0.42,
    room.wallHeight * renderSettings.wallHeightScale + 0.34,
  ];
}

function signalLabelPosition(node: ViewerNode): Vec3 {
  return [node.scene[0], node.scene[1], node.scene[2] + 0.42];
}

function agentLabelPosition(placement: AgentPlacement, renderSettings: RenderSettings): Vec3 {
  return [
    placement.position[0],
    placement.position[1],
    placement.position[2] + 0.58 * renderSettings.agentScale + 0.18,
  ];
}
