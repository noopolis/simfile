import { GlyphMesh } from "@glyphcss/react";
import type { Polygon } from "@glyphcss/core";
import { useMemo } from "react";

import type { RoomGeometry, RoomPath, ViewerNode } from "./types.js";
import type { ViewerSkin } from "./worldModel.js";
import type { RenderSettings } from "./renderSettings.js";
import type { AgentPlacement, Vec3 } from "./sceneMotion.js";
import {
  avatarTransforms,
  tintAvatarModel,
} from "./avatarModel.js";

interface SceneSegment {
  id: string;
  position: Vec3;
  scale: Vec3;
  rotation?: Vec3;
}

const corridorHeight = 0.06;
const roomWallThickness = 0.08;

export function CorridorMeshes({ path, renderSettings, skin }: {
  path: RoomPath;
  renderSettings: RenderSettings;
  skin: ViewerSkin;
}) {
  return (
    <>
      {pathSegments(path, renderSettings.roomScale).map((segment) => (
        <GlyphMesh
          color={skin.colors.path}
          geometry="cube"
          key={segment.id}
          position={segment.position}
          scale={segment.scale}
          rotation={segment.rotation}
        />
      ))}
    </>
  );
}

export function RoomMeshes({ paths, renderSettings, room, selected, skin }: {
  paths: RoomPath[];
  renderSettings: RenderSettings;
  room: RoomGeometry;
  selected: boolean;
  skin: ViewerSkin;
}) {
  const [cx, cy] = room.center;
  const [width, depth] = scaledRoomSize(room, renderSettings.roomScale);
  const wallHeight = room.wallHeight * renderSettings.wallHeightScale;
  const wallColor = selected ? skin.colors.probe : skin.colors.wall;
  const floorColor = selected ? skin.colors.room : skin.colors.floor;
  const furnitureColor = selected ? skin.colors.agent : skin.colors.world;
  const walls = wallSegments(room, width, depth, wallHeight, paths);
  return (
    <>
      <GlyphMesh color={floorColor} geometry="cube" position={[cx, cy, 0]} scale={[width, depth, 0.08]} />
      <GlyphMesh
        color={skin.colors.path}
        geometry="cube"
        position={[cx, cy, 0.065]}
        scale={[Math.max(0.4, width - 0.38), Math.max(0.3, depth - 0.36), 0.018]}
      />
      <RoomFloorDetail color={furnitureColor} depth={depth} room={room} width={width} />
      {walls.map((wall) => (
        <GlyphMesh
          color={wallColor}
          geometry="cube"
          key={`${room.id}:${wall.id}`}
          position={wall.position}
          scale={wall.scale}
        />
      ))}
      {room.node.value === "square"
        ? null
        : <RoomFurniture color={furnitureColor} depth={depth} room={room} width={width} />}
    </>
  );
}

export function AgentAvatar({ placement, polygons, renderSettings, selected, skin }: {
  placement: AgentPlacement;
  polygons: Polygon[] | null;
  renderSettings: RenderSettings;
  selected: boolean;
  skin: ViewerSkin;
}) {
  const color = selected
    ? skin.colors.probe
    : placement.moving ? skin.colors.pressure : skin.colors.agent;
  const transforms = avatarTransforms(placement, renderSettings);
  const tintedPolygons = useMemo(
    () => polygons ? tintAvatarModel(polygons, color) : null,
    [color, polygons],
  );
  return (
    <>
      <GlyphMesh
        color={color}
        geometry="cube"
        position={transforms.base.position}
        scale={transforms.base.scale}
      />
      {tintedPolygons && tintedPolygons.length > 0 ? (
        <GlyphMesh
          polygons={tintedPolygons}
          position={transforms.model.position}
          rotation={transforms.model.rotation}
          scale={transforms.model.scale}
        />
      ) : (
        <GlyphMesh
          color={color}
          geometry="cube"
          position={transforms.model.position}
          scale={[
            0.35 * renderSettings.agentScale,
            0.35 * renderSettings.agentScale,
            1.75 * renderSettings.agentScale,
          ]}
        />
      )}
    </>
  );
}

export function SignalMesh({ node, skin }: { node: ViewerNode; skin: ViewerSkin }) {
  return (
    <GlyphMesh
      color={skin.colors[node.colorRole]}
      geometry={node.geometry ?? (node.kind === "marker" ? "sphere" : "cube")}
      position={node.scene}
      scale={node.scale}
    />
  );
}

function RoomFurniture({ color, depth, room, width }: {
  color: string;
  depth: number;
  room: RoomGeometry;
  width: number;
}) {
  const [cx, cy] = room.center;
  const tableWidth = Math.min(0.9, width * 0.3);
  const tableDepth = Math.min(0.54, depth * 0.26);
  const seats = room.access.slice(0, 6).map((agent, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(3, Math.min(room.access.length, 6));
    return {
      id: `${room.id}:${agent}:seat`,
      position: [
        cx + Math.cos(angle) * (tableWidth * 0.7),
        cy + Math.sin(angle) * (tableDepth * 0.86),
        0.18,
      ] as Vec3,
    };
  });
  return (
    <>
      <GlyphMesh color={color} geometry="cube" position={[cx, cy, 0.12]} scale={[tableWidth, tableDepth, 0.1]} />
      {seats.map((seat) => (
        <GlyphMesh color={color} geometry="cube" key={seat.id} position={seat.position} scale={[0.1, 0.08, 0.12]} />
      ))}
    </>
  );
}

function RoomFloorDetail({ color, depth, room, width }: {
  color: string;
  depth: number;
  room: RoomGeometry;
  width: number;
}) {
  const [cx, cy] = room.center;
  const stripeWidth = Math.max(0.12, width * 0.035);
  const stripeDepth = Math.max(0.1, depth * 0.035);
  const postX = width / 2 - 0.12;
  const postY = depth / 2 - 0.12;
  const posts: SceneSegment[] = [
    { id: "nw", position: [cx - postX, cy - postY, 0.2], scale: [0.1, 0.1, 0.24] },
    { id: "ne", position: [cx + postX, cy - postY, 0.2], scale: [0.1, 0.1, 0.24] },
    { id: "sw", position: [cx - postX, cy + postY, 0.2], scale: [0.1, 0.1, 0.24] },
    { id: "se", position: [cx + postX, cy + postY, 0.2], scale: [0.1, 0.1, 0.24] },
  ];
  return (
    <>
      <GlyphMesh color={color} geometry="cube" position={[cx, cy, 0.092]} scale={[stripeWidth, depth - 0.34, 0.018]} />
      <GlyphMesh color={color} geometry="cube" position={[cx, cy, 0.096]} scale={[width - 0.34, stripeDepth, 0.018]} />
      {posts.map((post) => (
        <GlyphMesh color={color} geometry="cube" key={`${room.id}:post:${post.id}`} position={post.position} scale={post.scale} />
      ))}
    </>
  );
}

function pathSegments(path: RoomPath, roomScale: number): SceneSegment[] {
  const width = path.width * (1 + Math.max(0, roomScale - 1) * 0.2);
  return path.path.slice(0, -1).flatMap((start, index) => {
    const end = path.path[index + 1];
    if (!end) return [];
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const segmentLength = Math.hypot(dx, dy);
    if (segmentLength <= 0.0001) return [];
    return [{
      id: `${path.id}:${index}`,
      position: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2],
      rotation: [0, 0, Math.atan2(dy, dx)],
      scale: [segmentLength, width, corridorHeight],
    }];
  });
}

function wallSegments(
  room: RoomGeometry,
  width: number,
  depth: number,
  height: number,
  paths: RoomPath[],
): SceneSegment[] {
  const roomDoorways = doorwaysForRoom(room, width, depth, paths);
  return (["north", "south", "west", "east"] as WallSide[]).flatMap((side) =>
    wallSegmentsForSide(room, side, width, depth, height, roomDoorways[side]),
  );
}

type WallSide = "north" | "south" | "west" | "east";

const DoorOverlap = 0.24;

function wallSegmentsForSide(
  room: RoomGeometry,
  side: WallSide,
  width: number,
  depth: number,
  height: number,
  doorOffsets: number[],
): SceneSegment[] {
  const z = height / 2 + 0.08;
  const sideLength = side === "north" || side === "south" ? width : depth;
  const cuts = splitWallCuts(doorOffsets, sideLength, DoorOverlap);
  const half = roomWallThickness;
  if (cuts.length === 0) {
    return [solidWall(side, room.center[0], room.center[1], width, depth, z, half)];
  }
  return cuts.flatMap((cut) => {
    const segmentLength = cut[1] - cut[0];
    if (segmentLength <= 0.06) {
      return [];
    }
    if (side === "north" || side === "south") {
      const y = side === "north" ? room.center[1] - depth / 2 : room.center[1] + depth / 2;
      const x = room.center[0] - sideLength / 2 + cut[0] + segmentLength / 2;
      return [{ id: `${side}:${cut[0]}-${cut[1]}`, position: [x, y, z], scale: [segmentLength, half, height] }];
    }
    const x = side === "west" ? room.center[0] - width / 2 : room.center[0] + width / 2;
    const y = room.center[1] - sideLength / 2 + cut[0] + segmentLength / 2;
    return [{ id: `${side}:${cut[0]}-${cut[1]}`, position: [x, y, z], scale: [half, segmentLength, height] }];
  });
}

function solidWall(side: WallSide, cx: number, cy: number, width: number, depth: number, z: number, thickness: number): SceneSegment {
  if (side === "north") {
    return { id: side, position: [cx, cy - depth / 2, z], scale: [width + 0.12, thickness, 0.8] };
  }
  if (side === "south") {
    return { id: side, position: [cx, cy + depth / 2, z], scale: [width + 0.12, thickness, 0.8] };
  }
  if (side === "west") {
    return { id: side, position: [cx - width / 2, cy, z], scale: [thickness, depth + 0.12, 0.8] };
  }
  return { id: side, position: [cx + width / 2, cy, z], scale: [thickness, depth + 0.12, 0.8] };
}

function splitWallCuts(doorOffsets: number[], sideLength: number, overlap: number): Array<[number, number]> {
  if (doorOffsets.length === 0) return [];
  const halfDoor = overlap / 2;
  const ranges = doorOffsets
    .map((door) => [Math.max(0.04, door - halfDoor), Math.min(sideLength - 0.04, door + halfDoor)] as [number, number])
    .filter(([start, end]) => end - start > 0.02)
    .sort((left, right) => left[0] - right[0]);
  const holes = mergeRanges(ranges);
  const segments: Array<[number, number]> = [];
  let cursor = 0;
  for (const [start, end] of holes) {
    if (start > cursor + 0.03) segments.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < sideLength - 0.03) segments.push([cursor, sideLength]);
  return segments.filter(([start, end]) => end - start > 0.04);
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  if (ranges.length === 0) return [];
  const merged: Array<[number, number]> = [ranges[0]!];
  for (let index = 1; index < ranges.length; index += 1) {
    const range = ranges[index]!;
    const last = merged[merged.length - 1]!;
    if (range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1]);
      continue;
    }
    merged.push(range);
  }
  return merged;
}

function doorwaysForRoom(room: RoomGeometry, width: number, depth: number, paths: RoomPath[]): Record<WallSide, number[]> {
  const doors: Record<WallSide, number[]> = { north: [], south: [], west: [], east: [] };
  for (const path of paths) {
    const isFrom = path.from.id === room.id;
    const isTo = path.to.id === room.id;
    if (!isFrom && !isTo) {
      continue;
    }
    const pathPoint = isFrom ? path.path[0] : path.path[path.path.length - 1]!;
    const pointX = pathPoint[0];
    const pointY = pathPoint[1];
    const side = sideTowardPoint(room, width, depth, pathPoint);
    const roomWidth = width;
    const roomDepth = depth;
    const offset = side === "north" || side === "south"
      ? pointX - (room.center[0] - roomWidth / 2)
      : pointY - (room.center[1] - roomDepth / 2);
    doors[side].push(offset);
  }
  return {
    north: dedupeAndClamp(doors.north, width),
    south: dedupeAndClamp(doors.south, width),
    west: dedupeAndClamp(doors.west, depth),
    east: dedupeAndClamp(doors.east, depth),
  };
}

function scaledRoomSize(room: RoomGeometry, scale: number): [number, number] {
  return [room.size[0] * scale, room.size[1] * scale];
}

function sideTowardPoint(room: RoomGeometry, width: number, depth: number, point: Vec3): WallSide {
  const dxLeft = Math.abs(point[0] - (room.center[0] - width / 2));
  const dxRight = Math.abs((room.center[0] + width / 2) - point[0]);
  const dyTop = Math.abs(point[1] - (room.center[1] - depth / 2));
  const dyBottom = Math.abs((room.center[1] + depth / 2) - point[1]);
  const leftRight = Math.min(dxLeft, dxRight);
  if (leftRight <= dyTop && leftRight <= dyBottom) {
    return dxLeft <= dxRight ? "west" : "east";
  }
  return dyTop <= dyBottom ? "north" : "south";
}

function dedupeAndClamp(values: number[], span: number): number[] {
  const step = span > 0 ? span / 80 : 1;
  const normalized = values
    .map((value) => clamp(value, 0.05, span - 0.05))
    .map((value) => Number((Math.round(value / step) * step).toFixed(4)));
  const unique = [...new Set(normalized)].sort((a, b) => a - b);
  return unique;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
