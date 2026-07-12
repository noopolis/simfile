import type { RoomGeometry, RoomPath, ViewerNode } from "./types.js";

export type TileLayerId = "terrain" | "rooms" | "corridors" | "anchors" | "signals" | "agents";
export type TileTone =
  | "terrain"
  | "terrain-alt"
  | "wall"
  | "floor"
  | "corridor"
  | "room-anchor"
  | "agent"
  | "variable"
  | "marker"
  | "probe";

export interface TileCell {
  col: number;
  glyph: string;
  nodeId?: string;
  row: number;
  tone: TileTone;
}

export interface TileLayer {
  cells: TileCell[];
  id: TileLayerId;
}

export interface TileRect {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

export interface TileAnchor {
  col: number;
  nodeId: string;
  row: number;
}

export interface TileWorld {
  anchors: TileAnchor[];
  cols: number;
  layers: TileLayer[];
  roomRects: Record<string, TileRect>;
  rows: number;
}

interface BuildTileWorldOptions {
  nodes: ViewerNode[];
  roomPaths: RoomPath[];
  rooms: RoomGeometry[];
  roomScale: number;
  terrainMix: number;
}

interface Bounds {
  maxX: number;
  maxY: number;
  minX: number;
  minY: number;
}

const mapMargin = 4;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const roomGlyph = (roomId: string): string => roomId.replace(/^[^a-z0-9]*|[^a-z0-9].*$/giu, "").slice(0, 1).toUpperCase() || "R";

const signalGlyph = (kind: ViewerNode["kind"]): string => (
  kind === "variable" ? "v" : kind === "marker" ? "*" : "?"
);

const toneForNode = (kind: ViewerNode["kind"]): TileTone => {
  if (kind === "agent" || kind === "team") return "agent";
  if (kind === "variable") return "variable";
  if (kind === "marker") return "marker";
  if (kind === "probe") return "probe";
  return "room-anchor";
};

const terrainGlyph = (col: number, row: number, terrainMix: number): string => {
  const noise = Math.abs(Math.sin(col * 12.913 + row * 78.233)) % 1;
  if (noise > 0.96) return "`";
  if (noise > 0.84 * terrainMix) return ",";
  if (noise > 0.66 * terrainMix) return ".";
  return "·";
};

const linePoints = (from: [number, number], to: [number, number]): Array<[number, number]> => {
  const [fromCol, fromRow] = from;
  const [toCol, toRow] = to;
  const steps = Math.max(Math.abs(toCol - fromCol), Math.abs(toRow - fromRow), 1);
  return Array.from({ length: steps + 1 }, (_, index) => {
    const ratio = index / steps;
    return [
      Math.round(fromCol + (toCol - fromCol) * ratio),
      Math.round(fromRow + (toRow - fromRow) * ratio),
    ];
  });
};

const computeBounds = (rooms: RoomGeometry[], roomPaths: RoomPath[], nodes: ViewerNode[]): Bounds => {
  const points: Array<[number, number]> = [];
  for (const room of rooms) {
    points.push(
      [room.center[0] - room.size[0] / 2, room.center[1] - room.size[1] / 2],
      [room.center[0] + room.size[0] / 2, room.center[1] + room.size[1] / 2],
    );
  }
  for (const path of roomPaths) {
    for (const point of path.path) {
      points.push([point[0], point[1]]);
    }
  }
  for (const node of nodes) {
    points.push([node.scene[0], node.scene[1]]);
  }
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return {
    maxX: Math.max(...xs, 2),
    maxY: Math.max(...ys, 2),
    minX: Math.min(...xs, -2),
    minY: Math.min(...ys, -2),
  };
};

export const buildTileWorld = ({
  nodes,
  roomPaths,
  rooms,
  roomScale,
  terrainMix,
}: BuildTileWorldOptions): TileWorld => {
  const cellsPerUnit = Math.max(6, Math.round(7 * roomScale));
  const bounds = computeBounds(rooms, roomPaths, nodes);
  const width = bounds.maxX - bounds.minX || 1;
  const height = bounds.maxY - bounds.minY || 1;
  const cols = Math.max(52, Math.round(width * cellsPerUnit) + mapMargin * 2 + 1);
  const rows = Math.max(28, Math.round(height * cellsPerUnit) + mapMargin * 2 + 1);

  const pointToTile = (x: number, y: number): [number, number] => [
    clamp(Math.round((x - bounds.minX) * cellsPerUnit) + mapMargin, 0, cols - 1),
    clamp(Math.round((bounds.maxY - y) * cellsPerUnit) + mapMargin, 0, rows - 1),
  ];

  const terrain: TileCell[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const tone = (row + col) % 3 === 0 ? "terrain-alt" : "terrain";
      terrain.push({ col, glyph: terrainGlyph(col, row, terrainMix), row, tone });
    }
  }

  const roomRects: Record<string, TileRect> = {};
  const roomCells: TileCell[] = [];
  const anchorCells: TileCell[] = [];
  const anchors: TileAnchor[] = [];

  for (const room of rooms) {
    const [left, bottom] = pointToTile(room.center[0] - room.size[0] / 2, room.center[1] - room.size[1] / 2);
    const [right, top] = pointToTile(room.center[0] + room.size[0] / 2, room.center[1] + room.size[1] / 2);
    const rect: TileRect = {
      bottom: Math.max(bottom, top) + 1,
      left: Math.min(left, right) - 1,
      right: Math.max(left, right) + 1,
      top: Math.min(bottom, top) - 1,
    };
    roomRects[room.id] = rect;
    for (let row = rect.top; row <= rect.bottom; row += 1) {
      for (let col = rect.left; col <= rect.right; col += 1) {
        const edge = row === rect.top || row === rect.bottom || col === rect.left || col === rect.right;
        roomCells.push({
          col,
          glyph: edge ? "#" : ".",
          row,
          tone: edge ? "wall" : "floor",
        });
      }
    }
    const anchor = {
      col: Math.round((rect.left + rect.right) / 2),
      nodeId: room.id,
      row: Math.round((rect.top + rect.bottom) / 2),
    };
    anchors.push(anchor);
    anchorCells.push({
      col: anchor.col,
      glyph: roomGlyph(room.id),
      nodeId: room.id,
      row: anchor.row,
      tone: "room-anchor",
    });
  }

  const corridorCells: TileCell[] = [];
  for (const path of roomPaths) {
    const tiledPoints = path.path.map((point) => pointToTile(point[0], point[1]));
    for (let index = 1; index < tiledPoints.length; index += 1) {
      for (const [col, row] of linePoints(tiledPoints[index - 1]!, tiledPoints[index]!)) {
        corridorCells.push({ col, glyph: "=", row, tone: "corridor" });
      }
    }
    const start = tiledPoints[0];
    const end = tiledPoints[tiledPoints.length - 1];
    if (start) corridorCells.push({ col: start[0], glyph: "+", row: start[1], tone: "corridor" });
    if (end) corridorCells.push({ col: end[0], glyph: "+", row: end[1], tone: "corridor" });
  }

  const signalCells: TileCell[] = [];
  const agentCells: TileCell[] = [];
  for (const node of nodes) {
    if (node.kind === "room") {
      continue;
    }
    const [col, row] = pointToTile(node.scene[0], node.scene[1]);
    const cell: TileCell = {
      col,
      glyph: node.kind === "agent" ? "@" : node.kind === "team" ? "◈" : signalGlyph(node.kind),
      nodeId: node.id,
      row,
      tone: toneForNode(node.kind),
    };
    anchors.push({ col, nodeId: node.id, row });
    if (node.kind === "agent" || node.kind === "team") {
      agentCells.push(cell);
      continue;
    }
    signalCells.push(cell);
  }

  return {
    anchors,
    cols,
    layers: [
      { cells: terrain, id: "terrain" },
      { cells: roomCells, id: "rooms" },
      { cells: corridorCells, id: "corridors" },
      { cells: anchorCells, id: "anchors" },
      { cells: signalCells, id: "signals" },
      { cells: agentCells, id: "agents" },
    ],
    roomRects,
    rows,
  };
};
