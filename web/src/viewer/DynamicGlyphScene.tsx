import {
  GlyphScene,
  useGlyphSceneContext,
} from "@glyphcss/react";
import { resolveGeometry } from "@glyphcss/core";
import type { Polygon } from "@glyphcss/core";
import type { GlyphMeshHandle, GlyphMeshTransform } from "glyphcss";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { CSSProperties } from "react";

import {
  avatarTransforms,
  tintAvatarModel,
  useAvatarModel,
} from "./avatarModel.js";
import {
  DynamicGlyphCameraSync,
  SeededPerspectiveCamera,
  type GlyphLayerRegistry,
} from "./SceneCamera.js";
import {
  recordDynamicGlyphAfterMicrotask,
} from "./dynamicGlyphTelemetry.js";
import type { RenderSettings } from "./renderSettings.js";
import type { AgentPlacement } from "./sceneMotion.js";
import type { ViewerNode } from "./types.js";
import type { ViewerSkin } from "./worldModel.js";

export interface DynamicRendererConfig {
  renderer: "glyph" | "dom";
  scale: 1 | 2 | 4;
}

interface DynamicMeshSpec {
  key: string;
  polygons: Polygon[];
  transform: GlyphMeshTransform;
}

interface DynamicMeshEntry {
  handle: GlyphMeshHandle;
  polygons: Polygon[];
  transformSignature: string;
}

const geometryCache = new Map<string, Polygon[]>();

export function DynamicGlyphScene({
  agentPlacements,
  config,
  grid,
  registry,
  renderSettings,
  selectedNode,
  selectedSkin,
  signalNodes,
  style,
}: {
  agentPlacements: AgentPlacement[];
  config: DynamicRendererConfig;
  grid: { cols: number; rows: number };
  registry: GlyphLayerRegistry;
  renderSettings: RenderSettings;
  selectedNode: ViewerNode;
  selectedSkin: ViewerSkin;
  signalNodes: ViewerNode[];
  style: CSSProperties;
}) {
  return (
    <SeededPerspectiveCamera
      className="glyph-camera dynamic-glyph-camera"
      selectedNode={selectedNode}
      selectedSkin={selectedSkin}
    >
      <GlyphScene
        cellAspect={2}
        className="dynamic-glyph-host"
        cols={grid.cols}
        mode="solid"
        rows={grid.rows}
        style={style}
        useColors
      >
        <DynamicGlyphCameraSync registry={registry} scale={config.scale} />
        <DirectDynamicGlyphObjects
          agentPlacements={agentPlacements}
          renderSettings={renderSettings}
          scale={config.scale}
          selectedNodeId={selectedNode.id}
          selectedSkin={selectedSkin}
          signalNodes={signalNodes}
        />
      </GlyphScene>
    </SeededPerspectiveCamera>
  );
}

function DirectDynamicGlyphObjects({
  agentPlacements,
  renderSettings,
  scale,
  selectedNodeId,
  selectedSkin,
  signalNodes,
}: {
  agentPlacements: AgentPlacement[];
  renderSettings: RenderSettings;
  scale: number;
  selectedNodeId: string;
  selectedSkin: ViewerSkin;
  signalNodes: ViewerNode[];
}) {
  const { sceneRef } = useGlyphSceneContext();
  const avatarPolygons = useAvatarModel();
  const entriesRef = useRef(new Map<string, DynamicMeshEntry>());
  const specs = useMemo(
    () => dynamicMeshSpecs(
      agentPlacements,
      avatarPolygons,
      renderSettings,
      selectedNodeId,
      selectedSkin,
      signalNodes,
    ),
    [
      agentPlacements,
      avatarPolygons,
      renderSettings,
      selectedNodeId,
      selectedSkin,
      signalNodes,
    ],
  );

  useLayoutEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const target = globalThis as typeof globalThis & {
      __glyphPerf?: { raster?: number[] };
    };
    const before = target.__glyphPerf?.raster?.length ?? 0;
    const startedAt = performance.now();
    let changed = false;
    const active = new Set(specs.map((spec) => spec.key));
    for (const [key, entry] of entriesRef.current) {
      if (active.has(key)) continue;
      entry.handle.dispose();
      entriesRef.current.delete(key);
      changed = true;
    }
    for (const spec of specs) {
      const signature = transformSignature(spec.transform);
      const existing = entriesRef.current.get(spec.key);
      if (!existing) {
        entriesRef.current.set(spec.key, {
          handle: scene.add(spec.polygons, spec.transform),
          polygons: spec.polygons,
          transformSignature: signature,
        });
        changed = true;
        continue;
      }
      if (existing.polygons !== spec.polygons) {
        existing.handle.setPolygons(spec.polygons);
        existing.polygons = spec.polygons;
        changed = true;
      }
      if (existing.transformSignature !== signature) {
        existing.handle.setTransform(spec.transform);
        existing.transformSignature = signature;
        changed = true;
      }
    }
    if (changed) recordDynamicGlyphAfterMicrotask(before, startedAt, scale);
    if (changed) recordDynamicPositionFrame(specs.length);
  }, [scale, sceneRef, specs]);

  useEffect(() => () => {
    for (const entry of entriesRef.current.values()) entry.handle.dispose();
    entriesRef.current.clear();
  }, []);
  return null;
}

function dynamicMeshSpecs(
  placements: AgentPlacement[],
  avatarPolygons: Polygon[] | null,
  renderSettings: RenderSettings,
  selectedNodeId: string,
  skin: ViewerSkin,
  signalNodes: ViewerNode[],
): DynamicMeshSpec[] {
  const agents = placements.flatMap((placement) => {
    const fallback = placement.moving ? skin.colors.pressure : skin.colors.agent;
    const color = selectedNodeId === placement.node.id
      ? skin.colors.probe
      : fallback;
    const transforms = avatarTransforms(placement, renderSettings);
    const bodyPolygons = avatarPolygons?.length
      ? tintAvatarModel(avatarPolygons, color)
      : geometryPolygons("cube", color);
    return [
      {
        key: `agent:${placement.node.id}:base`,
        polygons: geometryPolygons("cube", color),
        transform: {
          id: `agent:${placement.node.id}:base`,
          position: transforms.base.position,
          scale: transforms.base.scale,
        },
      },
      {
        key: `agent:${placement.node.id}:man`,
        polygons: bodyPolygons,
        transform: {
          id: `agent:${placement.node.id}:man`,
          position: transforms.model.position,
          rotation: transforms.model.rotation,
          scale: avatarPolygons?.length
            ? transforms.model.scale
            : [
              0.35 * renderSettings.agentScale,
              0.35 * renderSettings.agentScale,
              1.75 * renderSettings.agentScale,
            ] as [number, number, number],
        },
      },
    ];
  });
  const signals = signalNodes.map((node) => ({
    key: `signal:${node.id}`,
    polygons: geometryPolygons(
      node.geometry ?? (node.kind === "marker" ? "sphere" : "cube"),
      skin.colors[node.colorRole],
    ),
    transform: {
      id: `signal:${node.id}`,
      position: node.scene,
      scale: node.scale,
    },
  }));
  return [...agents, ...signals];
}

function geometryPolygons(
  geometry: "cube" | "sphere",
  color: string,
): Polygon[] {
  const key = `${geometry}:${color}`;
  const cached = geometryCache.get(key);
  if (cached) return cached;
  const polygons = resolveGeometry(geometry, { color, size: 1 });
  geometryCache.set(key, polygons);
  return polygons;
}

function transformSignature(transform: GlyphMeshTransform): string {
  return JSON.stringify(transform);
}

function recordDynamicPositionFrame(commits: number): void {
  const target = globalThis as typeof globalThis & {
    __SIMFILE_PLAYBACK_DIAGNOSTICS__?: Record<string, number | boolean>;
  };
  const shared = target.__SIMFILE_PLAYBACK_DIAGNOSTICS__ ??= {};
  shared.positionCommits = Number(shared.positionCommits ?? 0) + commits;
  shared.positionFrames = Number(shared.positionFrames ?? 0) + 1;
}

export function readDynamicRendererConfig(
  search = typeof window === "undefined" ? "" : window.location.search,
): DynamicRendererConfig {
  const params = new URLSearchParams(search);
  const renderer = params.get("dynamic-renderer") === "dom" ? "dom" : "glyph";
  const requestedScale = Number(params.get("dynamic-scale") ?? 1);
  const scale = requestedScale === 2 || requestedScale === 4 ? requestedScale : 1;
  return { renderer, scale };
}

export function scaledRenderGrid(
  grid: { cols: number; rows: number },
  scale: number,
): { cols: number; rows: number } {
  return {
    cols: Math.max(20, Math.round(grid.cols / scale)),
    rows: Math.max(12, Math.round(grid.rows / scale)),
  };
}
