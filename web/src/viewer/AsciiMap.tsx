import { useMemo } from "react";
import type { CSSProperties } from "react";

import type { RenderSettings } from "./renderSettings.js";
import { buildTileWorld } from "./tileWorld.js";
import type { RoomPath, RoomGeometry, ViewerNode } from "./types.js";
import type { ViewerSkin } from "./worldModel.js";

interface AsciiMapProps {
  nodes: ViewerNode[];
  onSelect: (id: string) => void;
  renderSettings: RenderSettings;
  roomPaths: RoomPath[];
  rooms: RoomGeometry[];
  selectedNode: ViewerNode;
  selectedSkin: ViewerSkin;
  /** Increment 3: node `scope`s (`agent:`/`room:` refs) to render with the "glow" class — the seeded meme's first-appearance highlight (`../spreadModel.ts`'s `firstAppearanceGlowScopes`). Omitted/empty on a run with no seed spread. */
  glowScopes?: ReadonlySet<string>;
  /**
   * Node `scope`s that have a "descend into a mind" affordance (a `team:`
   * membrane node itself, or the agent that represents one) — rendered with
   * the `descendable` class and a "⤵" prefix on the anchor label
   * (`VIEW_DESIGN.md` rule 5's descend affordance). Omitted on a leaf-only
   * run (no membranes), which renders with zero affordance markup.
   */
  descendableScopes?: ReadonlySet<string>;
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
}: AsciiMapProps) {
  const tileWorld = useMemo(
    () => buildTileWorld({
      nodes,
      roomPaths,
      rooms,
      roomScale: renderSettings.roomScale,
      terrainMix: renderSettings.wallHeightScale,
    }),
    [nodes, renderSettings.roomScale, renderSettings.wallHeightScale, roomPaths, rooms],
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

  const selectedRoomId = useMemo(() => roomIdForNode(selectedNode), [selectedNode]);
  const glowNodeIds = useMemo(
    () => new Set(nodes.filter((node) => glowScopes?.has(node.scope)).map((node) => node.id)),
    [nodes, glowScopes],
  );
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
    return nodes.find((entry) => entry.id === anchor.nodeId)?.kind === "room";
  });

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
          const node = nodes.find((entry) => entry.id === anchor.nodeId);
          if (!node) {
            return null;
          }
          const selected = node.id === selectedNode.id;
          const glowing = glowNodeIds.has(node.id);
          const descendable = Boolean(descendableScopes?.has(node.scope));
          const short = node.kind === "room" ? node.label : `${glyphForNode(node)} ${node.label}`;
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
        <span><strong>@</strong> agent</span>
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
  const roomMatch = node.scope.match(/^room:[^:]+:([^:]+)$/u);
  return roomMatch?.[1] ?? null;
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
