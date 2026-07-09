import type { RoomGeometry, RoomPath } from "./types.js";

export interface RoomLayout {
  paths: RoomPath[];
  rooms: RoomGeometry[];
}

export function createRoomLayout(rooms: RoomGeometry[], paths: RoomPath[], roomScale: number): RoomLayout {
  const spread = 1 + Math.max(0, roomScale - 1) * 0.92;
  const center = layoutCenter(rooms);
  const spreadRoomsList = spreadRooms(rooms, center, spread);
  const spreadRoomById = new Map(spreadRoomsList.map((room) => [room.id, room]));
  const spreadPaths = paths.map((path) => ({
    ...path,
    path: path.path.map((point) => spreadPoint(point, center, spread)),
    from: spreadRoomById.get(path.from.id) ?? path.from,
    to: spreadRoomById.get(path.to.id) ?? path.to,
  }));
  return {
    paths: spreadPaths,
    rooms: spreadRoomsList,
  };
}

function spreadRooms(rooms: RoomGeometry[], center: [number, number], spread: number): RoomGeometry[] {
  return rooms.map((room) => ({
    ...room,
    center: [
      round(center[0] + (room.center[0] - center[0]) * spread),
      round(center[1] + (room.center[1] - center[1]) * spread),
      room.center[2],
    ],
    size: [room.size[0] * spread, room.size[1] * spread],
    wallHeight: round(room.wallHeight * (1 + (spread - 1) * 0.28)),
  }));
}

function spreadPoint(point: [number, number, number], center: [number, number], spread: number): [number, number, number] {
  return [
    round(center[0] + (point[0] - center[0]) * spread),
    round(center[1] + (point[1] - center[1]) * spread),
    point[2],
  ];
}

function layoutCenter(rooms: RoomGeometry[]): [number, number] {
  if (rooms.length === 0) {
    return [0, 0];
  }
  const total = rooms.reduce<[number, number]>((sum, room) => [
    sum[0] + room.center[0],
    sum[1] + room.center[1],
  ], [0, 0]);
  return [total[0] / rooms.length, total[1] / rooms.length];
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
