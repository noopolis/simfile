import type { Simfile, SimfileRoute } from "../schema/model.js";
import type { RuntimeTrace, RuntimeTraceEvent } from "./types.js";
import type {
  ViewerPresence,
  ViewerSpatialSample,
  ViewerTraceAgent,
  ViewerTraceCorridor,
  ViewerTraceRoom
} from "./viewer-trace.js";

const roomScopePattern = /^room:([^:]+):([^:]+)$/u;
const agentScopePattern = /^agent:([^:]+)$/u;

export const spatialRoomId = (simfile: Pick<Simfile, "name">, placeId: string): string =>
  `room:${simfile.name}:${placeId}`;

const sceneForIndex = (index: number, count: number): [number, number, number] => {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const row = Math.floor(index / cols);
  const col = index % cols;
  const x = (col - (cols - 1) / 2) * 3.2;
  const y = (row - Math.max(0, Math.ceil(count / cols) - 1) / 2) * 2.4;
  return [Number(x.toFixed(2)), Number(y.toFixed(2)), 0];
};

const legacyRoomScopes = (simfile: Simfile, trace: RuntimeTrace): string[] => {
  const scopes = new Set<string>();
  for (const variable of Object.values(simfile.variables)) {
    if (roomScopePattern.test(variable.scope)) scopes.add(variable.scope);
  }
  for (const marker of Object.values(simfile.markers)) {
    for (const scope of marker.scopes) if (roomScopePattern.test(scope)) scopes.add(scope);
  }
  for (const event of trace.events) {
    for (const scope of [event.scope, event.target]) {
      if (roomScopePattern.test(scope)) scopes.add(scope);
    }
  }
  return [...scopes].sort();
};

const membersByPlace = (trace: RuntimeTrace): Map<string, Set<string>> => {
  const result = new Map<string, Set<string>>();
  const add = (place: string, agent: string): void => {
    const members = result.get(place) ?? new Set<string>();
    members.add(agent);
    result.set(place, members);
  };
  for (const sample of trace.samples) {
    for (const [place, agents] of Object.entries(sample.occupancy)) {
      for (const agent of agents) add(place, agent);
    }
    for (const transit of sample.transit) {
      add(transit.from, transit.agent);
      add(transit.to, transit.agent);
    }
  }
  return result;
};

export const buildViewerRooms = (simfile: Simfile, trace: RuntimeTrace): ViewerTraceRoom[] => {
  const members = membersByPlace(trace);
  const drafts: Array<Omit<ViewerTraceRoom, "scene" | "scale">> = Object.entries(simfile.places)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([placeId, place]) => ({
      id: spatialRoomId(simfile, placeId),
      kind: place.kind,
      label: place.label ?? placeId,
      members: [...(members.get(placeId) ?? [])].sort(),
      place_id: placeId,
      scope: spatialRoomId(simfile, placeId)
    }));

  const knownIds = new Set(drafts.map((room) => room.id));
  for (const scope of legacyRoomScopes(simfile, trace)) {
    if (knownIds.has(scope)) continue;
    drafts.push({
      id: scope,
      kind: "room",
      label: scope.match(roomScopePattern)?.[2] ?? scope,
      members: [],
      scope
    });
  }

  return drafts.map((room, index) => ({
    ...room,
    scene: sceneForIndex(index, drafts.length),
    scale: [1.4, 0.9]
  }));
};

const routePath = (from: ViewerTraceRoom, to: ViewerTraceRoom): Array<{ x: number; y: number }> => {
  const start = { x: from.scene[0], y: from.scene[1] };
  const end = { x: to.scene[0], y: to.scene[1] };
  return start.x === end.x || start.y === end.y
    ? [start, end]
    : [start, { x: end.x, y: start.y }, end];
};

export const buildViewerCorridors = (
  simfile: Simfile,
  rooms: readonly ViewerTraceRoom[]
): ViewerTraceCorridor[] => {
  const byId = new Map(rooms.map((room) => [room.id, room]));
  const routes = Object.entries(simfile.routes).sort(([left], [right]) => left.localeCompare(right));
  if (routes.length > 0 || Object.keys(simfile.places).length > 0) {
    return routes.flatMap(([id, route]) => {
      const from = byId.get(spatialRoomId(simfile, route.from));
      const to = byId.get(spatialRoomId(simfile, route.to));
      if (!from || !to) return [];
      return [{
        direction: route.direction,
        from_room: from.id,
        id,
        path: routePath(from, to),
        to_room: to.id,
        travel_ticks: route.travel_ticks,
        width: 0.08
      }];
    });
  }

  return rooms.slice(1).map((room, index) => {
    const from = rooms[index]!;
    return {
      from_room: from.id,
      id: `${from.id}--${room.id}`,
      path: routePath(from, room),
      to_room: room.id,
      width: 0.08
    };
  });
};

const placedAgentIds = (simfile: Simfile, trace: RuntimeTrace): Set<string> => {
  const agents = new Set(Object.keys(simfile.presence));
  for (const sample of trace.samples) {
    for (const occupants of Object.values(sample.occupancy)) {
      for (const agent of occupants) agents.add(agent);
    }
    for (const transit of sample.transit) agents.add(transit.agent);
  }
  return agents;
};

export const buildViewerAgents = (simfile: Simfile, trace: RuntimeTrace): ViewerTraceAgent[] => {
  const placed = placedAgentIds(simfile, trace);
  const agents = new Set(placed);
  for (const event of trace.events) {
    const target = event.target.match(agentScopePattern)?.[1];
    if (target) agents.add(target);
    if (event.provenance === "agentic" && event.actor !== "@world") agents.add(event.actor);
  }
  return [...agents].sort().map((id) => placed.has(id) ? {
    detail: "Presence-driven body placed from spatial telemetry.",
    id,
    label: id,
    scope: `agent:${id}`
  } : {
    detail: "Heuristic placement: trace has this agent but no presence stream yet.",
    id,
    label: id,
    label_hint: "heuristic",
    scope: `agent:${id}`
  });
};

const payloadRecord = (event: RuntimeTraceEvent): Record<string, unknown> =>
  typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {};

const eventTick = (event: RuntimeTraceEvent): number => {
  const tick = payloadRecord(event).tick;
  return typeof tick === "number" ? tick : 0;
};

const routeAllows = (route: SimfileRoute, from: string, to: string): boolean =>
  (route.from === from && route.to === to)
  || (route.direction === "bidirectional" && route.from === to && route.to === from);

const routeIdFor = (simfile: Simfile, from: string, to: string): string | undefined =>
  Object.entries(simfile.routes)
    .sort(([left], [right]) => left.localeCompare(right))
    .find(([, route]) => routeAllows(route, from, to))?.[0];

const transitAtDeparture = (trace: RuntimeTrace, actor: string, from: string, tick: number) =>
  trace.samples.find((sample) => sample.tick === tick)?.transit.find((entry) => entry.agent === actor && entry.from === from);

export const buildViewerPresence = (simfile: Simfile, trace: RuntimeTrace): ViewerPresence[] => {
  const result: ViewerPresence[] = [];
  for (const event of trace.events) {
    const tick = eventTick(event);
    const place = payloadRecord(event).place;
    if (event.kind === "presence.arrived" && typeof place === "string") {
      result.push({ actor: event.actor, room: spatialRoomId(simfile, place), tick, type: "presence.arrived" });
      continue;
    }
    if (event.kind !== "presence.left" || typeof place !== "string") continue;
    const transit = transitAtDeparture(trace, event.actor, place, tick);
    if (!transit) continue;
    const pathId = routeIdFor(simfile, transit.from, transit.to);
    if (!pathId) continue;
    const fromRoom = spatialRoomId(simfile, transit.from);
    const toRoom = spatialRoomId(simfile, transit.to);
    const arrivedAt = tick + transit.ticksRemaining;
    result.push({
      actor: event.actor,
      from_room: fromRoom,
      path_id: pathId,
      tick,
      to_room: toRoom,
      type: "presence.departed"
    });
    result.push({
      actor: event.actor,
      arrived_at: arrivedAt,
      from_room: fromRoom,
      path_id: pathId,
      started_at: tick,
      tick,
      to_room: toRoom,
      type: "presence.in_transit"
    });
  }
  return result;
};

export const buildViewerSpatialSamples = (simfile: Simfile, trace: RuntimeTrace): ViewerSpatialSample[] => {
  if (Object.keys(simfile.places).length === 0) return [];
  return trace.samples.map((sample) => ({
    occupancy: Object.fromEntries(Object.entries(sample.occupancy).map(([place, agents]) => [
      spatialRoomId(simfile, place),
      [...agents]
    ])),
    tick: sample.tick,
    transit: sample.transit.map((entry) => ({
      agent: entry.agent,
      from_room: spatialRoomId(simfile, entry.from),
      path_id: routeIdFor(simfile, entry.from, entry.to) ?? "",
      ticks_remaining: entry.ticksRemaining,
      to_room: spatialRoomId(simfile, entry.to)
    }))
  }));
};
