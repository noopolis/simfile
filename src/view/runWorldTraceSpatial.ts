import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseRunManifest } from "../observe/manifest.js";
import { readWorldTelemetry } from "./runRawArtifacts.js";
import type { RunTimeline, TimelineEvent } from "./runTimelineTypes.js";
import type { RunTelemetrySample } from "./runViewModelTypes.js";
import type {
  RunWorldTrace,
  RunWorldTraceCorridor,
  RunWorldTraceLedgerFact,
  RunWorldTracePresence,
  RunWorldTraceRoom,
} from "./runWorldTrace.js";

export interface RunSpatialPlace {
  kind: string;
  label?: string;
}

export interface RunSpatialRoute {
  direction: "bidirectional" | "one_way";
  from: string;
  to: string;
  travelTicks: number;
}

export interface RunSpatialWorld {
  networkId: string;
  places: Record<string, RunSpatialPlace>;
  presence: Record<string, string>;
  routes: Record<string, RunSpatialRoute>;
  samples: Array<RunTelemetrySample & {
    occupancy: Record<string, string[]>;
    transit: NonNullable<RunTelemetrySample["transit"]>;
  }>;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const parsePlaces = (value: unknown): Record<string, RunSpatialPlace> | undefined => {
  const record = asRecord(value);
  if (!record || Object.keys(record).length === 0) return undefined;
  const places: Record<string, RunSpatialPlace> = {};
  for (const [id, raw] of Object.entries(record)) {
    const place = asRecord(raw);
    if (!place || typeof place.kind !== "string") return undefined;
    if (place.label !== undefined && typeof place.label !== "string") return undefined;
    places[id] = { kind: place.kind, ...(typeof place.label === "string" ? { label: place.label } : {}) };
  }
  return places;
};

const parseRoutes = (value: unknown): Record<string, RunSpatialRoute> | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  const routes: Record<string, RunSpatialRoute> = {};
  for (const [id, raw] of Object.entries(record)) {
    const route = asRecord(raw);
    if (!route || typeof route.from !== "string" || typeof route.to !== "string"
      || !Number.isInteger(route.travel_ticks) || (route.travel_ticks as number) < 1
      || (route.direction !== "bidirectional" && route.direction !== "one_way")) return undefined;
    routes[id] = {
      direction: route.direction,
      from: route.from,
      to: route.to,
      travelTicks: route.travel_ticks as number,
    };
  }
  return routes;
};

const parsePresence = (value: unknown): Record<string, string> | undefined => {
  const record = asRecord(value);
  if (!record || !Object.values(record).every((place) => typeof place === "string")) return undefined;
  return record as Record<string, string>;
};

/**
 * Strict additive gate. A chat-only run cannot enter this branch merely by
 * carrying generic telemetry: all three spatial manifest maps must parse,
 * `places` must be non-empty, and at least one telemetry sample must carry
 * both canonical `occupancy` and `transit` fields.
 */
export const readRunSpatialWorld = async (runDir: string): Promise<RunSpatialWorld | undefined> => {
  const raw = JSON.parse(await readFile(path.join(runDir, "manifest.json"), "utf8")) as unknown;
  const manifest = parseRunManifest(raw);
  const world = manifest.world;
  const places = parsePlaces(world?.places);
  const routes = parseRoutes(world?.routes);
  const presence = parsePresence(world?.presence);
  if (!places || !routes || !presence) return undefined;
  const placeIds = new Set(Object.keys(places));
  if (Object.values(routes).some((route) => !placeIds.has(route.from) || !placeIds.has(route.to))) return undefined;
  if (Object.values(presence).some((place) => !placeIds.has(place))) return undefined;

  const telemetry = await readWorldTelemetry(runDir);
  if (!telemetry || telemetry.length === 0 || !telemetry.every((sample) =>
    sample.occupancy !== undefined && sample.transit !== undefined
  )) return undefined;
  const samples = telemetry as RunSpatialWorld["samples"];

  const networkId = typeof world?.network_id === "string" ? world.network_id : manifest.run_id;
  return { networkId, places, routes, presence, samples };
};

const roomId = (world: RunSpatialWorld, place: string): string => `room:${world.networkId}:${place}`;

const sceneForIndex = (index: number, count: number): [number, number, number] => {
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.ceil(count / columns);
  const x = (index % columns - (columns - 1) / 2) * 3.2;
  const y = (Math.floor(index / columns) - Math.max(0, rows - 1) / 2) * 2.4;
  return [Number(x.toFixed(2)), Number(y.toFixed(2)), 0];
};

const membersByPlace = (world: RunSpatialWorld): Map<string, Set<string>> => {
  const members = new Map<string, Set<string>>();
  const add = (place: string, agent: string): void => {
    const set = members.get(place) ?? new Set<string>();
    set.add(agent);
    members.set(place, set);
  };
  for (const [agent, place] of Object.entries(world.presence)) add(place, agent);
  for (const sample of world.samples) {
    for (const [place, agents] of Object.entries(sample.occupancy)) {
      for (const agent of agents) add(place, agent);
    }
    for (const transit of sample.transit) {
      add(transit.from, transit.agent);
      add(transit.to, transit.agent);
    }
  }
  return members;
};

const buildRooms = (world: RunSpatialWorld): RunWorldTraceRoom[] => {
  const members = membersByPlace(world);
  const entries = Object.entries(world.places).sort(([left], [right]) => left.localeCompare(right));
  return entries.map(([placeId, place], index) => ({
    id: roomId(world, placeId),
    kind: "room",
    label: place.label ?? placeId,
    scope: roomId(world, placeId),
    members: [...(members.get(placeId) ?? [])].sort(),
    place_id: placeId,
    scene: sceneForIndex(index, entries.length),
    scale: [1.4, 0.9],
  }));
};

const corridorPath = (from: RunWorldTraceRoom, to: RunWorldTraceRoom): Array<{ x: number; y: number }> => {
  const start = { x: from.scene[0], y: from.scene[1] };
  const end = { x: to.scene[0], y: to.scene[1] };
  return start.x === end.x || start.y === end.y ? [start, end] : [start, { x: end.x, y: start.y }, end];
};

const buildCorridors = (world: RunSpatialWorld, rooms: readonly RunWorldTraceRoom[]): RunWorldTraceCorridor[] => {
  const byId = new Map(rooms.map((room) => [room.id, room]));
  return Object.entries(world.routes).sort(([left], [right]) => left.localeCompare(right)).flatMap(([id, route]) => {
    const from = byId.get(roomId(world, route.from));
    const to = byId.get(roomId(world, route.to));
    if (!from || !to) return [];
    return [{
      direction: route.direction,
      from_room: from.id,
      id,
      path: corridorPath(from, to),
      to_room: to.id,
      travel_ticks: route.travelTicks,
      width: 0.08,
    }];
  });
};

const payloadRecord = (event: TimelineEvent): Record<string, unknown> => asRecord(event.payload) ?? {};
const eventAgent = (event: TimelineEvent): string | undefined => {
  const payload = payloadRecord(event);
  return typeof payload.agent === "string" ? payload.agent : event.actor;
};
const eventPlace = (event: TimelineEvent): string | undefined => {
  const place = payloadRecord(event).place;
  return typeof place === "string" ? place : undefined;
};
const sourceTick = (event: TimelineEvent): number => {
  const tick = payloadRecord(event).tick;
  return typeof tick === "number" ? tick : event.t;
};

const routeIdFor = (world: RunSpatialWorld, from: string, to: string): string | undefined =>
  Object.entries(world.routes).sort(([left], [right]) => left.localeCompare(right)).find(([, route]) =>
    (route.from === from && route.to === to)
    || (route.direction === "bidirectional" && route.from === to && route.to === from)
  )?.[0];

const buildPresence = (world: RunSpatialWorld, timeline: RunTimeline): RunWorldTracePresence[] => {
  const result: RunWorldTracePresence[] = [];
  for (const [index, event] of timeline.events.entries()) {
    const agent = eventAgent(event);
    const place = eventPlace(event);
    if (!agent || !place) continue;
    if (event.type === "presence.arrived") {
      result.push({ actor: agent, room: roomId(world, place), tick: event.t, type: "presence.arrived" });
      continue;
    }
    if (event.type !== "presence.left") continue;
    const transit = world.samples.find((sample) => sample.tick === sourceTick(event))?.transit
      .find((entry) => entry.agent === agent && entry.from === place);
    if (!transit) continue;
    const pathId = routeIdFor(world, transit.from, transit.to);
    if (!pathId) continue;
    const futureArrival = timeline.events.slice(index + 1).find((candidate) =>
      candidate.type === "presence.arrived" && eventAgent(candidate) === agent && eventPlace(candidate) === transit.to
    );
    const arrivedAt = futureArrival?.t ?? event.t + transit.ticksRemaining;
    result.push({
      actor: agent,
      from_room: roomId(world, transit.from),
      path_id: pathId,
      tick: event.t,
      to_room: roomId(world, transit.to),
      type: "presence.departed",
    });
    result.push({
      actor: agent,
      arrived_at: arrivedAt,
      from_room: roomId(world, transit.from),
      path_id: pathId,
      started_at: event.t,
      tick: event.t,
      to_room: roomId(world, transit.to),
      type: "presence.in_transit",
    });
  }
  return result;
};

export const buildSpatialRunWorldTrace = (params: {
  runId: string;
  runName: string;
  spatialWorld: RunSpatialWorld;
  timeline: RunTimeline;
  ledgerFacts: RunWorldTraceLedgerFact[];
}): RunWorldTrace => {
  const { runId, runName, spatialWorld: world, timeline, ledgerFacts } = params;
  const rooms = buildRooms(world);
  const agentIds = new Set(Object.keys(world.presence));
  for (const sample of world.samples) {
    for (const agents of Object.values(sample.occupancy)) for (const agent of agents) agentIds.add(agent);
    for (const transit of sample.transit) agentIds.add(transit.agent);
  }
  return {
    version: "viewer.trace.v1",
    run_id: runId,
    run_name: runName,
    rooms,
    corridors: buildCorridors(world, rooms),
    agents: [...agentIds].sort().map((id) => ({
      id,
      label: id,
      scope: `agent:${id}`,
      detail: "Presence-driven body placed from spatial telemetry.",
    })),
    presence: buildPresence(world, timeline),
    ledger_facts: ledgerFacts,
    signals: [],
    spatial_samples: world.samples.map((sample) => ({
      occupancy: Object.fromEntries(Object.entries(sample.occupancy).map(([place, agents]) => [roomId(world, place), [...agents]])),
      tick: sample.tick,
      transit: sample.transit.map((entry) => ({
        agent: entry.agent,
        from_room: roomId(world, entry.from),
        path_id: routeIdFor(world, entry.from, entry.to) ?? "",
        ticks_remaining: entry.ticksRemaining,
        to_room: roomId(world, entry.to),
      })),
    })),
  };
};
