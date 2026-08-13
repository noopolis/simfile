import { useEffect, useMemo } from "react";
import type { CSSProperties } from "react";

import type { RenderSettings } from "./renderSettings.js";
import { createAgentPlacements } from "./sceneMotion.js";
import { buildTileWorld } from "./tileWorld.js";
import type { RoomPath, RoomGeometry, ViewerNode, ViewerPresenceEvent, ViewerSpatialSample } from "./types.js";
import type { ViewerSkin } from "./worldModel.js";
import { spatialSampleAtTick } from "./spatialObjectModel.js";
import { WorldMapRendererHost } from "./WorldMapRendererHost.js";
import type { ViewerPrimarySurface, WorldMapRendererFrame } from "./WorldMapRendererHost.js";
import { selectWorldMapRenderer } from "./worldMapRendererCatalog.js";
import { buildWorldMapRendererFrame } from "./worldMapRendererFrame.js";

/** Geometry seed required by renderer hosts; never presented as an observed tick. */
const TIMELESS_GEOMETRY_SEED = 0;

interface AsciiMapProps {
  nodes: ViewerNode[];
  onSelect: (id: string) => void;
  renderSettings: RenderSettings;
  roomPaths: RoomPath[];
  rooms: RoomGeometry[];
  selectedNode: ViewerNode;
  selectedSkin: ViewerSkin;
  /**
   * Simulated world tick represented by this map. `undefined` means the record
   * states no time, so the map renders a timeless frame instead of asserting
   * tick 0 or borrowing the scrub cursor, which is an event index.
   */
  tick?: number;
  presenceByAgent?: Record<string, ViewerPresenceEvent[]>;
  spatialSamples?: ViewerSpatialSample[];
  tickDurationMs: number;
  extensionData?: unknown;
  extensionIdentities?: WorldMapRendererFrame["extensionIdentities"];
  cursor?: WorldMapRendererFrame["cursor"];
  /** Increment 3: node `scope`s (`agent:`/`room:` refs) to render with the "glow" class — the seeded meme's first-appearance highlight (`../spreadModel.ts`'s `firstAppearanceGlowScopes`). Omitted/empty on a run with no seed spread. */
  glowScopes?: ReadonlySet<string>;
  /**
   * Node `scope`s that have a "descend into a mind" affordance — carried by
   * the membrane representative's own agent body and rendered with the
   * `descendable` class and a "⤵" prefix on the anchor label
   * (`VIEW_DESIGN.md` rule 5's descend affordance). Omitted on a leaf-only
   * run (no membranes), which renders with zero affordance markup.
   */
  descendableScopes?: ReadonlySet<string>;
  onPrimarySurfaceOwnershipChange?: (
    surfaces: readonly ViewerPrimarySurface[],
  ) => void;
}

export function AsciiMap({
  nodes,
  onSelect,
  renderSettings,
  roomPaths,
  rooms,
  selectedNode,
  selectedSkin,
  glowScopes,
  descendableScopes,
  tick,
  presenceByAgent = {},
  spatialSamples = [],
  tickDurationMs,
  extensionData,
  extensionIdentities,
  cursor,
  onPrimarySurfaceOwnershipChange,
}: AsciiMapProps) {
  const geometryTick = tick ?? TIMELESS_GEOMETRY_SEED;
  const rendererFrame = useMemo(() => buildWorldMapRendererFrame({
    nodes,
    onSelect,
    selectedNodeId: selectedNode.id,
    spatialSamples: tick === undefined && cursor === undefined ? [] : spatialSamples,
    tick: geometryTick,
    tickDurationMs,
    extensionData,
    extensionIdentities,
    cursor,
  }), [cursor, extensionData, extensionIdentities, geometryTick, nodes, onSelect, selectedNode.id, spatialSamples, tick, tickDurationMs]);
  const worldMapRenderer = useMemo(
    () => selectWorldMapRenderer(rendererFrame),
    [rendererFrame],
  );
  useEffect(() => {
    onPrimarySurfaceOwnershipChange?.(
      worldMapRenderer?.ownedPrimarySurfaces ?? [],
    );
    return () => onPrimarySurfaceOwnershipChange?.([]);
  }, [onPrimarySurfaceOwnershipChange, worldMapRenderer]);
  const agentPlacements = useMemo(
    () => tick === undefined
      ? []
      : createAgentPlacements({
        nodes,
        paths: roomPaths,
        presenceByAgent,
        roomScale: renderSettings.roomScale,
        rooms,
        tick,
      }),
    [nodes, presenceByAgent, renderSettings.roomScale, roomPaths, rooms, tick],
  );
  const displayNodes = useMemo(() => {
    const byAgent = new Map(agentPlacements.map((placement) => [placement.node.id, placement]));
    const objects = new Map(
      (tick === undefined ? [] : spatialSampleAtTick(spatialSamples, tick)?.objects ?? [])
        .map((object) => [object.id, object]),
    );
    return nodes.map((node) => {
      const object = objects.get(node.id);
      if (object) {
        const speed = object.velocity === undefined ? undefined : Math.hypot(...object.velocity);
        return {
          ...node,
          in_transit: speed === undefined ? false : speed > 0,
          scene: [object.position[0], object.position[1], node.scene[2]] as [number, number, number],
          subtitle: speed === undefined ? "position sampled" : `moving · speed ${speed.toFixed(2)}`,
          value: `${object.position[0].toFixed(2)}, ${object.position[1].toFixed(2)}`,
        };
      }
      const placement = byAgent.get(node.id);
      if (!placement) return node;
      return {
        ...node,
        in_transit: placement.moving,
        scene: placement.position,
        subtitle: placement.moving
          ? `in transit · ${placement.roomId} → ${placement.nextRoomId}`
          : `occupying ${placement.roomId}`,
        transit_heading: placement.heading,
        value: placement.moving ? "in transit" : placement.roomId,
      };
    });
  }, [agentPlacements, nodes, spatialSamples, tick]);
  const tileWorld = useMemo(
    () => buildTileWorld({
      nodes: displayNodes,
      roomPaths,
      rooms,
      roomScale: renderSettings.roomScale,
      terrainMix: renderSettings.wallHeightScale,
    }),
    [displayNodes, renderSettings.roomScale, renderSettings.wallHeightScale, roomPaths, rooms],
  );

  const cellMap = useMemo(() => {
    const composed = new Map<string, { glyph: string; nodeId?: string; tone: string }>();
    for (const layer of tileWorld.layers) {
      for (const cell of layer.cells) {
        composed.set(`${cell.row}:${cell.col}`, cell);
      }
    }
    return composed;
  }, [tileWorld.layers]);

  const displayedSelection = displayNodes.find((node) => node.id === selectedNode.id) ?? selectedNode;
  const selectedRoomId = useMemo(() => roomIdForNode(displayedSelection), [displayedSelection]);
  const glowNodeIds = useMemo(
    () => new Set(displayNodes.filter((node) => glowScopes?.has(node.scope)).map((node) => node.id)),
    [displayNodes, glowScopes],
  );
  const occupantsByRoom = useMemo(() => {
    const sample = tick === undefined
      ? undefined
      : spatialSamples.filter((entry) => entry.tick <= tick).at(-1);
    if (sample) return sample.occupancy;
    const occupancy: Record<string, string[]> = {};
    for (const placement of agentPlacements) {
      if (!placement.moving) (occupancy[placement.roomId] ??= []).push(placement.node.label);
    }
    return occupancy;
  }, [agentPlacements, spatialSamples, tick]);
  const hasSpatialPresence = tick !== undefined
    && (Object.keys(presenceByAgent).length > 0 || spatialSamples.length > 0);
  const stageStyle = useMemo(() => ({
    "--tile-cols": String(tileWorld.cols),
    "--tile-rows": String(tileWorld.rows),
    "--tile-font-size": `${(11 * renderSettings.density).toFixed(2)}px`,
    "--tile-line-height": `${(10 * renderSettings.density).toFixed(2)}px`,
    "--tile-agent-scale": String(renderSettings.agentScale),
    "--tile-room": selectedSkin.colors.room,
    "--tile-path": selectedSkin.colors.path,
    "--tile-agent": selectedSkin.colors.agent,
    "--tile-variable": selectedSkin.colors.variable,
    "--tile-marker": selectedSkin.colors.marker,
    "--tile-probe": selectedSkin.colors.probe,
  }) as CSSProperties, [renderSettings.agentScale, renderSettings.density, selectedSkin.colors, tileWorld.cols, tileWorld.rows]);

  const anchors = tileWorld.anchors.filter((anchor) => {
    if (anchor.nodeId === selectedNode.id) {
      return true;
    }
    if (!renderSettings.showLabels) {
      return false;
    }
    return displayNodes.find((entry) => entry.id === anchor.nodeId)?.kind === "room";
  });

  if (worldMapRenderer) {
    return (
      <div className="ascii-stage fixture-renderer-stage" style={stageStyle}>
        <WorldMapRendererHost frame={rendererFrame} renderer={worldMapRenderer} />
      </div>
    );
  }

  return (
    <div className="ascii-stage" style={stageStyle}>
      <div className="ascii-grid" role="img" aria-label="Simfile replay tile map">
        {Array.from({ length: tileWorld.rows }, (_, row) =>
          Array.from({ length: tileWorld.cols }, (_, col) => {
            const key = `${row}:${col}`;
            const cell = cellMap.get(key) ?? { glyph: "·", tone: "terrain" };
            const roomHit = selectedRoomId ? roomRectContains(tileWorld.roomRects[selectedRoomId], row, col) : false;
            const selected = cell.nodeId === selectedNode.id || roomHit;
            const glowing = Boolean(cell.nodeId && glowNodeIds.has(cell.nodeId));
            const className = [
              "tile-cell",
              `tone-${cell.tone}`,
              selected ? "selected" : "",
              glowing ? "glow" : "",
            ].filter(Boolean).join(" ");

            if (cell.nodeId) {
              return (
                <button
                  aria-label={cell.nodeId}
                  className={className}
                  key={key}
                  onClick={() => onSelect(cell.nodeId!)}
                  type="button"
                >
                  {cell.glyph}
                </button>
              );
            }

            return <span className={className} key={key}>{cell.glyph}</span>;
          }),
        )}
      </div>

      <div className="ascii-overlay" aria-hidden="true">
        {anchors.map((anchor) => {
          const node = displayNodes.find((entry) => entry.id === anchor.nodeId);
          if (!node) {
            return null;
          }
          const selected = node.id === selectedNode.id;
          const glowing = glowNodeIds.has(node.id);
          const descendable = Boolean(descendableScopes?.has(node.scope));
          const occupants = node.kind === "room" ? occupantsByRoom[node.id] ?? [] : [];
          const short = node.kind === "room"
            ? `${node.label}${hasSpatialPresence ? ` · ${occupants.length > 0 ? occupants.join(", ") : "empty"}` : ""}`
            : `${glyphForNode(node)} ${node.label}`;
          return (
            <button
              className={[
                "tile-anchor",
                selected ? "selected" : "",
                glowing ? "glow" : "",
                descendable ? "descendable" : "",
              ].filter(Boolean).join(" ")}
              key={`${anchor.nodeId}:${anchor.row}:${anchor.col}`}
              onClick={() => onSelect(anchor.nodeId)}
              style={{
                gridColumn: anchor.col + 1,
                gridRow: anchor.row + 1,
              }}
              type="button"
            >
              <span>{descendable ? "⤵ " : ""}{short}</span>
              {renderSettings.showLabels ? <small>{node.kind}</small> : null}
            </button>
          );
        })}
      </div>

      <div className="ascii-legend" aria-label="Tile legend">
        <span><strong>@</strong> occupant</span>
        <span><strong>⇢</strong> in transit</span>
        <span><strong>v</strong> variable</span>
        <span><strong>*</strong> marker</span>
        <span><strong>?</strong> probe</span>
        <span><strong>#</strong> room wall</span>
        <span><strong>=</strong> corridor</span>
      </div>
    </div>
  );
}

function glyphForNode(node: ViewerNode): string {
  if (node.kind === "agent") return "@";
  if (node.kind === "team") return "◈";
  if (node.kind === "variable") return "v";
  if (node.kind === "marker") return "*";
  if (node.kind === "probe") return "?";
  return "#";
}

function roomIdForNode(node: ViewerNode): string | null {
  if (node.kind === "room") {
    return node.id;
  }
  if (node.kind === "agent" && node.value !== "heuristic") {
    return node.value;
  }
  return /^room:[^:]+:[^:]+$/u.test(node.scope) ? node.scope : null;
}

function roomRectContains(
  rect: { bottom: number; left: number; right: number; top: number } | undefined,
  row: number,
  col: number,
): boolean {
  if (!rect) {
    return false;
  }
  return row >= rect.top && row <= rect.bottom && col >= rect.left && col <= rect.right;
}
