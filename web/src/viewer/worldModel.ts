import type {
  RoomGeometry,
  RoomPath,
  WallSide,
  Vec3,
  ViewerColorRole,
  ViewerContractTrace,
  ViewerDerivedWorld,
  ViewerEventRow,
  ViewerLedgerFact,
  ViewerPresenceEvent,
  ViewerSignal,
  ViewerTraceAgent,
  ViewerTraceCorridor,
  ViewerTraceRoom,
  ViewerNode,
  ViewerSpatialSample,
} from "./types.js";

const floorZ = 0.055;
const defaultPathWidth = 0.08;
const roomScaleFactor = 1.18;
const roomCrowdScale = 0.11;
const wallHeightPerActor = 0.018;
const roomDoorGapScale = 0.3;
const roomWallHeightBase = 0.28;

export interface ViewerSkin {
  id: string;
  label: string;
  className: string;
  camera: {
    rotX: number;
    rotY: number;
    zoom: number;
    distance: number;
  };
  colors: Record<ViewerColorRole, string>;
}

export const viewerSkins: ViewerSkin[] = [
  {
    id: "default",
    label: "Moltnet Console",
    className: "skin-moltnet",
    camera: { rotX: 58, rotY: 42, zoom: 58, distance: 980 },
    colors: {
      room: "#7c5cff",
      agent: "#f3eee7",
      pressure: "#d4604a",
      variable: "#d4604a",
      marker: "#00e5cc",
      probe: "#a78bfa",
      world: "#d1c7b8",
      floor: "#173323",
      wall: "#2fa969",
      path: "#4b6858",
    },
  },
  {
    id: "office",
    label: "Office Floor",
    className: "skin-office",
    camera: { rotX: 62, rotY: 34, zoom: 62, distance: 940 },
    colors: {
      room: "#69d2c7",
      agent: "#f6d365",
      pressure: "#ff7b65",
      variable: "#ff7b65",
      marker: "#8be9fd",
      probe: "#8fd694",
      world: "#e8ded2",
      floor: "#183d42",
      wall: "#58bcb2",
      path: "#60756f",
    },
  },
  {
    id: "night",
    label: "Night Ops",
    className: "skin-night",
    camera: { rotX: 55, rotY: 52, zoom: 56, distance: 1020 },
    colors: {
      room: "#8be9fd",
      agent: "#f15bb5",
      pressure: "#ffb86c",
      variable: "#ffb86c",
      marker: "#bd93f9",
      probe: "#50fa7b",
      world: "#c0caf5",
      floor: "#1a1530",
      wall: "#7c5dc8",
      path: "#50486a",
    },
  },
];

export const buildViewerWorld = (trace: ViewerContractTrace): ViewerDerivedWorld => {
  const roomGeometries = buildRoomGeometries(trace.rooms);
  const roomPaths = buildRoomPaths(trace.corridors, roomGeometries);
  const presenceByAgent = groupPresence(trace.presence);
  const nodes = [
    ...trace.rooms.map((room) => toRoomNode(room)),
    ...trace.agents.map((agent) => toAgentNode(agent, roomGeometries, presenceByAgent)),
    ...trace.signals.map((signal) => toSignalNode(signal)),
  ];

  const tickDurationMs = Number.isFinite(trace.tick_duration_ms)
    && (trace.tick_duration_ms ?? 0) > 0
    ? trace.tick_duration_ms!
    : 20;
  return {
    inspectionsByNode: Object.fromEntries((trace.inspections ?? []).map((entry) => [entry.node_id, entry])),
    inspectionSamples: trace.inspection_samples ?? [],
    nodes,
    roomGeometries,
    roomPaths,
    ledgerRows: toLedgerRows(trace.ledger_facts),
    presenceByAgent,
    spatialSamples: trimUnpresentableSpatialPrefix(
      trace.spatial_samples ?? [],
      tickDurationMs,
    ),
    tickDurationMs,
    ...(trace.viewer_extension_data === undefined
      ? {}
      : { viewerExtensionData: trace.viewer_extension_data }),
    ...(trace.viewer_extensions === undefined
      ? {}
      : { viewerExtensionIdentities: trace.viewer_extensions }),
  };
};

/**
 * Older bounded traces could leave one orphaned opening keyframe before a
 * multi-second authored reset. No position exists to present inside that gap,
 * so replay begins at the first post-reset sample rather than showing a long
 * false freeze.
 */
export const trimUnpresentableSpatialPrefix = (
  samples: ViewerSpatialSample[],
  tickDurationMs: number,
): ViewerSpatialSample[] => {
  let start = 0;
  while (start + 1 < samples.length) {
    const prior = samples[start]!;
    const next = samples[start + 1]!;
    const gapMs = (next.tick - prior.tick) * tickDurationMs;
    const priorIds = prior.objects?.map((object) => object.id) ?? [];
    if (
      gapMs <= 2_000
      || priorIds.length === 0
      || !priorIds.every((id) => next.discontinuities?.includes(id))
    ) {
      break;
    }
    start += 1;
  }
  return start === 0 ? samples : samples.slice(start);
};

const buildRoomGeometries = (rooms: ViewerTraceRoom[]): RoomGeometry[] =>
  rooms.map((room) => {
    const size = roomScale(room);
    const members = room.members.length;
    const wallHeight = roundTo(room.wall_height ?? roomWallHeightBase + members * wallHeightPerActor);
    return {
      access: [...room.members],
      center: [room.scene[0], room.scene[1], 0],
      doorCutters: emptyDoorCutters(),
      id: room.id,
      node: toRoomNode(room),
      size,
      wallHeight,
    };
  });

const buildRoomPaths = (corridors: ViewerTraceCorridor[], rooms: RoomGeometry[]): RoomPath[] => {
  const roomById = new Map<string, RoomGeometry>(rooms.map((room) => [room.id, room]));
  const paths = corridors.flatMap((corridor) => {
    const from = roomById.get(corridor.from_room);
    const to = roomById.get(corridor.to_room);
    if (!from || !to || corridor.path.length < 2) {
      return [];
    }
    const path = corridor.path.map((point) => [point.x, point.y, floorZ] as Vec3);
    const width = corridor.width ?? defaultPathWidth;
    const roomPath: RoomPath = {
      id: corridor.id,
      from,
      to,
      path,
      width,
    };
    if (path.length > 0) {
      addDoorCut(from, path[0]!, width, corridor.id);
      addDoorCut(to, path[path.length - 1]!, width, corridor.id);
    }
    return [roomPath];
  });
  return paths;
};

export const roomPoint = (
  room: RoomGeometry,
  agentId: string,
  roomScale = 1,
  drift = 0,
): Vec3 => {
  const [rx, ry] = roomTokenPoint(room, agentId);
  return [
    room.center[0] + rx * roomScale + Math.cos(drift) * 0.04,
    room.center[1] + ry * roomScale + Math.sin(drift) * 0.03,
    floorZ,
  ];
};

const roomScale = (room: ViewerTraceRoom): [number, number] => {
  const [width, depth] = room.scale ?? [1.35, 0.9];
  const crowd = Math.min(room.members.length, 8);
  return [
    roundTo(width * roomScaleFactor + crowd * roomCrowdScale),
    roundTo(depth * roomScaleFactor + crowd * (roomCrowdScale * 0.6)),
  ];
};

const toRoomNode = (room: ViewerTraceRoom): ViewerNode => ({
  id: room.id,
  label: room.label,
  kind: "room",
  scope: room.scope,
  subtitle: `${room.kind ?? "room"} · ${room.members.length} known occupants`,
  detail: room.place_id
    ? `Spatial place ${room.place_id}; occupancy follows the replay tick.`
    : "Room layout and connectivity from trace contract.",
  value: room.kind ?? "room",
  x: 0,
  y: 0,
  camera: [0.5, 0.5],
  scene: room.scene,
  scale: [room.scale?.[0] ?? 1.5, room.scale?.[1] ?? 1.0, 0.3],
  colorRole: room.id === "case-warroom" ? "pressure" : room.id === "after-work-chat" ? "marker" : "room",
});

const toAgentNode = (
  agent: ViewerTraceAgent,
  rooms: RoomGeometry[],
  presenceByAgent: Record<string, ViewerPresenceEvent[]>,
): ViewerNode => {
  const roomById = new Map(rooms.map((room) => [room.id, room]));
  const roomId = inferStartingRoom(agent.id, roomById, presenceByAgent);
  const room = roomById.get(roomId) ?? rooms[0];
  const point = room ? roomPoint(room, agent.id, 1, 0) : [0, 0, floorZ];
  const hasPresence = (presenceByAgent[agent.id]?.length ?? 0) > 0;
  const heuristic = agent.label_hint === "heuristic" && !hasPresence;
  return {
    id: agent.id,
    label: agent.label ?? agent.id,
    kind: "agent",
    scope: agent.scope,
    subtitle: heuristic ? "heuristic · no presence stream" : "presence-driven",
    detail: agent.detail ?? (heuristic
      ? "Agent exists in trace data but is not rendered as a room body without presence events."
      : "Body follows presence events."),
    value: heuristic ? "heuristic" : roomId,
    x: 0,
    y: 0,
    camera: [0.5, 0.5],
    scene: room ? [point[0], point[1], point[2]] : [0, 0, floorZ],
    scale: 0.18,
    colorRole: "agent",
  };
};

const inferStartingRoom = (
  actorId: string,
  roomById: Map<string, RoomGeometry>,
  presenceByAgent: Record<string, ViewerPresenceEvent[]>,
): string => {
  const events = presenceByAgent[actorId] ?? [];
  const initialArrival = events.find((event) => event.type === "presence.arrived");
  if (initialArrival && roomById.has(initialArrival.room)) {
    return initialArrival.room;
  }
  const first = [...roomById.keys()][0];
  return first ?? "office-hall";
};

const toSignalNode = (signal: ViewerSignal): ViewerNode => ({
  ...(signal.geometry === undefined ? {} : { geometry: signal.geometry }),
  id: signal.id,
  label: signal.label,
  kind: signal.kind,
  scope: signal.scope,
  subtitle: signal.id,
  detail: signal.detail,
  value: signal.value,
  x: 0,
  y: 0,
  camera: [0.5, 0.5],
  scene: signal.scene,
  scale: signal.scale ?? 0.18,
  colorRole: signal.kind,
});

const toLedgerRows = (events: ViewerLedgerFact[]): ViewerEventRow[] =>
  events.map((event) => ({
    actor: event.actor,
    detail: event.detail,
    target: event.target,
    time: `t+${event.tick}`,
    type: event.type,
  }));

export const groupPresence = (events: ViewerPresenceEvent[]): Record<string, ViewerPresenceEvent[]> => {
  const byAgent = events
    .slice()
    .sort((left, right) => left.tick - right.tick)
    .reduce<Record<string, ViewerPresenceEvent[]>>((acc, event) => {
      const bucket = acc[event.actor] ?? [];
      bucket.push(event);
      acc[event.actor] = bucket;
      return acc;
    }, {});
  return byAgent;
};

const roomTokenPoint = (room: RoomGeometry, agentId: string): [number, number] => {
  const roster = room.access.length > 0 ? room.access : [agentId];
  const index = Math.max(0, roster.indexOf(agentId));
  const count = Math.max(3, roster.length || 1);
  const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
  const spread = Math.max(1, Math.min(1.38, roster.length / 4));
  return [
    Math.cos(angle) * (room.size[0] * 0.3 * spread),
    Math.sin(angle) * (room.size[1] * 0.26 * spread),
  ];
};

const addDoorCut = (room: RoomGeometry, point: Vec3, _pathWidth: number, _pathId: string): void => {
  const side = nearestSide(room, point);
  const offset = side === "north" || side === "south"
    ? point[0] - (room.center[0] - room.size[0] / 2)
    : point[1] - (room.center[1] - room.size[1] / 2);
  room.doorCutters[side].push([offset, 0]);
};

const nearestSide = (room: RoomGeometry, point: Vec3): WallSide => {
  const dxLeft = Math.abs(point[0] - (room.center[0] - room.size[0] / 2));
  const dxRight = Math.abs((room.center[0] + room.size[0] / 2) - point[0]);
  const dyUp = Math.abs(point[1] - (room.center[1] - room.size[1] / 2));
  const dyDown = Math.abs((room.center[1] + room.size[1] / 2) - point[1]);
  const minX = Math.min(dxLeft, dxRight);
  if (minX <= dyUp && minX <= dyDown) {
    return dxLeft <= dxRight ? "west" : "east";
  }
  return dyUp <= dyDown ? "north" : "south";
};

const emptyDoorCutters = (): Record<WallSide, Array<[number, number]>> => ({
  north: [],
  south: [],
  west: [],
  east: [],
});

const roundTo = (value: number): number => Number(value.toFixed(2));

export const viewerDoorGap = (size: number): number => Number((size * roomDoorGapScale).toFixed(2));
