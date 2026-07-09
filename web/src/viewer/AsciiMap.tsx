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
}

export function AsciiMap({
  nodes,
  onSelect,
  renderSettings,
  roomPaths,
  rooms,
  selectedNode,
  selectedSkin,
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
            const className = [
              "tile-cell",
              `tone-${cell.tone}`,
              selected ? "selected" : "",
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
          const short = node.kind === "room" ? node.label : `${glyphForNode(node)} ${node.label}`;
          return (
            <button
              className={`tile-anchor ${selected ? "selected" : ""}`}
              key={`${anchor.nodeId}:${anchor.row}:${anchor.col}`}
              onClick={() => onSelect(anchor.nodeId)}
              style={{
                gridColumn: anchor.col + 1,
                gridRow: anchor.row + 1,
              }}
              type="button"
            >
              <span>{short}</span>
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
