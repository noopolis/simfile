import type { RoomGeometry, RoomPath, ViewerNode, ViewerPresenceEvent } from "./types.js";

export type Vec3 = [number, number, number];

export interface AgentPlacement {
  animation: {
    clip: "idle" | "walk" | "run";
    phase: number;
    timeScale: number;
  };
  heading: number;
  labelPosition: Vec3;
  moving: boolean;
  nextRoomId: string;
  node: ViewerNode;
  position: Vec3;
  roomId: string;
  speedMps: number;
  stride: number;
}

const floorZ = 0.055;
const defaultStride = 0.5;

type RoomById = Map<string, RoomGeometry>;
type PathById = Map<string, RoomPath>;

export interface MovementInputs {
  nodes: ViewerNode[];
  tick: number;
  paths: RoomPath[];
  presenceByAgent: Record<string, ViewerPresenceEvent[]>;
  roomScale?: number;
  rooms: RoomGeometry[];
}

export function createAgentPlacements({
  nodes,
  tick,
  paths,
  presenceByAgent,
  roomScale = 1,
  rooms,
}: MovementInputs): AgentPlacement[] {
  const roomById = new Map(rooms.map((room) => [room.id, room]));
  const pathById = new Map(paths.map((path) => [path.id, path]));
  return nodes
    .filter((node) => node.kind === "agent")
    .filter((node) => node.value !== "heuristic" || (presenceByAgent[node.id]?.length ?? 0) > 0)
    .map((node, index) => {
      const events = presenceByAgent[node.id] ?? [];
      const placement = placementForAgent({
        agent: node,
        events,
        roomById,
        pathById,
        roomScale,
        index,
        tick,
      });
      return placement;
    });
}

interface PlacementInput {
  agent: ViewerNode;
  events: ViewerPresenceEvent[];
  index: number;
  pathById: PathById;
  roomById: RoomById;
  roomScale: number;
  tick: number;
}

const placementForAgent = ({
  agent,
  events,
  index,
  pathById,
  roomById,
  roomScale,
  tick,
}: PlacementInput): AgentPlacement => {
  if (events.length === 0) {
    const room = firstRoom(roomById, agent.id);
    const point = roomPoint(room, agent.id, roomScale, driftForIndex(index, tick));
    return makePlacement(agent, point, point, room.id, room.id, false, Math.sin(driftForIndex(index, tick)));
  }
  const inTransit = mostRecentInTransit(events, tick);
  if (inTransit && inTransit.type === "presence.in_transit") {
    const path = pathById.get(inTransit.path_id);
    if (!path) {
      return fallbackTransit(agent, inTransit, roomById, roomScale, index, tick);
    }
    const progress = easedProgress(inTransit, tick);
    const { point, target } = samplePath(path.path, progress);
    return makePlacement(
      agent,
      point,
      target,
      inTransit.from_room,
      inTransit.to_room,
      true,
      strideByTime(tick, index),
    );
  }

  const arrived = mostRecentArrival(events, tick);
  if (arrived) {
    const room = roomById.get(arrived.room) ?? firstRoom(roomById, agent.id);
    const point = roomPoint(room, agent.id, roomScale, driftForIndex(index, tick));
    return makePlacement(agent, point, point, room.id, room.id, false, strideByTime(tick, index));
  }

  const departed = mostRecentDeparted(events, tick);
  if (departed) {
    const from = roomById.get(departed.from_room) ?? firstRoom(roomById, agent.id);
    const to = roomById.get(departed.to_room);
    const target = to?.center ?? from.center;
    return makePlacement(
      agent,
      roomPoint(from, agent.id, roomScale, 0),
      [target[0], target[1], floorZ],
      departed.from_room,
      departed.to_room,
      true,
      strideByTime(tick, index),
    );
  }

  const room = firstRoom(roomById, agent.id);
  const fallback = roomPoint(room, agent.id, roomScale, driftForIndex(index, tick));
  return makePlacement(agent, fallback, fallback, room.id, room.id, false, strideByTime(tick, index));
};

const makePlacement = (
  node: ViewerNode,
  position: Vec3,
  target: Vec3,
  roomId: string,
  nextRoomId: string,
  moving: boolean,
  stride: number,
): AgentPlacement => ({
  animation: { clip: "idle", phase: 0, timeScale: 0 },
  heading: angleToward(target, position),
  labelPosition: [position[0], position[1], position[2] + 0.72],
  moving,
  nextRoomId,
  node,
  position,
  roomId,
  speedMps: 0,
  stride,
});

const mostRecentInTransit = (
  events: ViewerPresenceEvent[],
  tick: number
): Extract<ViewerPresenceEvent, { type: "presence.in_transit" }> | undefined => {
  const candidates = events.filter((event) =>
    event.type === "presence.in_transit" && event.started_at <= tick && tick < event.arrived_at,
  );
  return candidates.at(-1) as Extract<ViewerPresenceEvent, { type: "presence.in_transit" }> | undefined;
};

const mostRecentArrival = (
  events: ViewerPresenceEvent[],
  tick: number
): Extract<ViewerPresenceEvent, { type: "presence.arrived" }> | undefined => {
  const candidates = events.filter((event) => event.type === "presence.arrived" && event.tick <= tick);
  return candidates.at(-1) as Extract<ViewerPresenceEvent, { type: "presence.arrived" }> | undefined;
};

const mostRecentDeparted = (
  events: ViewerPresenceEvent[],
  tick: number
): Extract<ViewerPresenceEvent, { type: "presence.departed" }> | undefined => {
  const candidates = events.filter((event) =>
    event.type === "presence.departed" && event.tick <= tick,
  );
  return candidates.at(-1) as Extract<ViewerPresenceEvent, { type: "presence.departed" }> | undefined;
};

const fallbackTransit = (
  agent: ViewerNode,
  event: Extract<ViewerPresenceEvent, { type: "presence.in_transit" }>,
  roomById: RoomById,
  roomScale: number,
  index: number,
  tick: number,
): AgentPlacement => {
  const fromRoom = roomById.get(event.from_room) ?? firstRoom(roomById, agent.id);
  const toRoom = roomById.get(event.to_room) ?? fromRoom;
  const progress = easedProgress(event, tick);
  const start = roomPoint(fromRoom, agent.id, roomScale, driftForIndex(index, tick));
  const end = roomPoint(toRoom, agent.id, roomScale, driftForIndex(index + 3, tick));
  const point = lerp3(start, end, progress);
  return makePlacement(agent, point, end, fromRoom.id, toRoom.id, true, strideByTime(tick, index));
};

const easedProgress = (
  event: Extract<ViewerPresenceEvent, { type: "presence.in_transit" }>,
  tick: number,
): number => {
  if (event.arrived_at <= event.started_at) {
    return 1;
  }
  const raw = clamp((tick - event.started_at) / (event.arrived_at - event.started_at), 0, 1);
  return raw * raw * (3 - 2 * raw);
};

const samplePath = (points: Vec3[], progress: number): { point: Vec3; target: Vec3 } => {
  if (points.length <= 1) {
    const point = points[0] ?? [0, 0, floorZ];
    return { point, target: point };
  }
  const segments = points.slice(1).reduce(
    (acc, point, index) => {
      const prev = points[index]!;
      const length = distance3(prev, point);
      acc.lengths.push(length);
      acc.total += length;
      acc.spans.push({ end: acc.total, endPoint: point, index: index + 1, startPoint: prev });
      return acc;
    },
    { lengths: [] as number[], total: 0, spans: [] as Array<{ end: number; startPoint: Vec3; endPoint: Vec3; index: number }> },
  );
  if (segments.total <= 0) {
    const point = points[0]!;
    return { point, target: point };
  }
  const targetLength = progress * segments.total;
  for (const span of segments.spans) {
    if (targetLength > span.end) {
      continue;
    }
    const startLength = span.end - segments.lengths[span.index - 1]!;
    const local = (targetLength - startLength) / (span.end - startLength);
    return {
      point: lerp3(span.startPoint, span.endPoint, clamp(local, 0, 1)),
      target: span.endPoint,
    };
  }
  const last = points[points.length - 1]!;
  return { point: last, target: last };
};

const distance3 = (left: Vec3, right: Vec3): number =>
  Math.hypot(right[0] - left[0], right[1] - left[1], right[2] - left[2]);

const angleToward = (target: Vec3, position: Vec3): number => Math.atan2(target[1] - position[1], target[0] - position[0]);

const lerp3 = (start: Vec3, end: Vec3, amount: number): Vec3 => [
  start[0] + (end[0] - start[0]) * amount,
  start[1] + (end[1] - start[1]) * amount,
  start[2] + (end[2] - start[2]) * amount,
];

const firstRoom = (roomById: RoomById, fallback: string): RoomGeometry => {
  return roomById.get(fallback) ?? roomById.values().next().value ?? { id: "fallback", access: [fallback], center: [0, 0, floorZ], size: [1, 1], wallHeight: 0.3, node: {
    camera: [0.5, 0.5],
    colorRole: "room",
	    id: fallback,
	    label: fallback,
    kind: "room",
    scene: [0, 0, floorZ],
    scale: [1, 1, 0.2],
    subtitle: "missing room",
    scope: "room:unknown",
    value: "room",
    detail: "fallback room for missing presence data",
    x: 0,
    y: 0,
  }, doorCutters: { north: [], south: [], west: [], east: [] } };
};

const roomPoint = (room: RoomGeometry, agentId: string, roomScale: number, drift: number): Vec3 => {
  const roster = room.access.length > 0 ? room.access : [agentId];
  const index = Math.max(0, roster.indexOf(agentId));
  const count = Math.max(3, roster.length);
  const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
  const spread = Math.max(1, Math.min(1.38, roster.length / 4));
  const radiusX = room.size[0] * roomScale * 0.3 * spread;
  const radiusY = room.size[1] * roomScale * 0.26 * spread;
  return [
    room.center[0] + Math.cos(angle) * radiusX + Math.cos(drift) * 0.04,
    room.center[1] + Math.sin(angle) * radiusY + Math.sin(drift) * 0.03,
    floorZ,
  ];
};

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const driftForIndex = (index: number, tick: number): number => (tick + index * 3) * 0.28;

const strideByTime = (tick: number, index: number): number => Math.sin((tick + index * 5) * 1.12) * defaultStride;
