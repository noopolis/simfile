import type { RunTimeline, RunTimelineMembrane } from "./runTimelineTypes.js";
import { parseRoomRef, stripRefPrefix } from "./runTimelineRefs.js";
import { buildSpatialRunWorldTrace, type RunSpatialWorld } from "./runWorldTraceSpatial.js";

/**
 * Adapts a run-replay `RunTimeline` into the same `viewer.trace.v1` shape
 * `web/src/viewer/worldModel.ts`'s `buildViewerWorld` already consumes, so
 * the existing `AsciiMap`/`worldModel`/`renderSettings` render this run's
 * map unchanged (`docs/VIEW_DESIGN.md`'s two-layer rule). This type is a
 * structural mirror of `web/src/viewer/types.ts`'s `ViewerContractTrace` —
 * a deliberate duplicate, not a cross-package import, matching this
 * package's existing src/web boundary: the contract is the JSON shape on
 * the wire, not a shared TS type.
 *
 * A composed run carrying the explicit spatial manifest + telemetry contract
 * is projected through `runWorldTraceSpatial.ts`. Older/chat-only runs retain
 * the original informational-anchor branch byte-for-byte in shape.
 */
export interface RunWorldTraceRoom {
  id: string;
  kind: "room";
  label: string;
  scope: string;
  members: string[];
  scene: [number, number, number];
  access_hint?: string;
  place_id?: string;
  scale?: [number, number];
}

export interface RunWorldTraceCorridor {
  direction?: "bidirectional" | "one_way";
  from_room: string;
  id: string;
  path: Array<{ x: number; y: number }>;
  to_room: string;
  travel_ticks?: number;
  width?: number;
}

export interface RunWorldTraceAgent {
  id: string;
  label?: string;
  scope: string;
  label_hint?: string;
  detail?: string;
}

export type RunWorldTraceLedgerFactType =
  | "clock.sync"
  | "presence.arrived"
  | "presence.left"
  | "world.message"
  | "world.dm"
  | "rule.fired"
  | "marker.seen"
  | "probe"
  | "other";

export interface RunWorldTraceLedgerFact {
  type: RunWorldTraceLedgerFactType;
  tick: number;
  event_id: string;
  kind: string;
  sim_time: number;
  provenance: "mechanical" | "agentic" | "external";
  actor: string;
  target: string;
  detail: string;
  scope?: string;
  payload: unknown;
}

export type RunWorldTracePresence =
  | { actor: string; room: string; tick: number; type: "presence.arrived" }
  | { actor: string; from_room: string; path_id: string; tick: number; to_room: string; type: "presence.departed" }
  | {
      actor: string;
      arrived_at: number;
      from_room: string;
      path_id: string;
      started_at: number;
      tick: number;
      to_room: string;
      type: "presence.in_transit";
    };

/** Exact world-space bodies for this tick; absent for room-presence-only runs. */
export interface RunWorldTraceSpatialObject {
  id: string;
  position: [number, number];
  /** World units per SECOND — see `runFrames.ts` on why the unit matters. */
  velocity: [number, number];
}

export interface RunWorldTraceSpatialSample {
  /** Object ids that cut rather than interpolate into this sample. */
  discontinuities?: string[];
  objects?: RunWorldTraceSpatialObject[];
  occupancy: Record<string, string[]>;
  tick: number;
  transit: Array<{
    agent: string;
    from_room: string;
    path_id: string;
    ticks_remaining: number;
    to_room: string;
  }>;
}

export interface RunWorldTrace {
  version: "viewer.trace.v1";
  run_id: string;
  run_name: string;
  rooms: RunWorldTraceRoom[];
  corridors: RunWorldTraceCorridor[];
  agents: RunWorldTraceAgent[];
  presence: RunWorldTracePresence[];
  ledger_facts: RunWorldTraceLedgerFact[];
  signals: never[];
  spatial_samples: RunWorldTraceSpatialSample[];
  /**
   * Simulated milliseconds per tick. The client's interpolation clock
   * multiplies recorded velocities by a duration derived from this, so an
   * omitted value silently falls back to 20ms and misdraws any run whose
   * tick is not 20ms.
   */
  tick_duration_ms?: number;
  /** Opaque, integrity-checked payloads keyed only by declared extension id. */
  viewer_extension_data?: Readonly<Record<string, unknown>>;
  /** Declared module identity and current evidence status; no executable paths. */
  viewer_extensions?: readonly Readonly<{
    id: string;
    status: "recorded" | "unsealed/local";
  }>[];
}

export const NO_PLACE_CAPTION =
  "no place-bearing world in this run — a chat-only room, rendered as an informational anchor";

const ledgerFactType = (kind: string, viewClass: string): RunWorldTraceLedgerFactType => {
  if (kind === "clock.sync" || kind === "presence.arrived" || kind === "presence.left"
    || kind === "world.message" || kind === "world.dm"
    || kind === "rule.fired" || kind === "marker.seen") return kind;
  if (viewClass === "message") return "world.message";
  return "other";
};

const anchorLedgerFactType = (viewClass: string): RunWorldTraceLedgerFactType => {
  if (viewClass === "message") return "world.message";
  return "other";
};

const provenanceFor = (authority: string): RunWorldTraceLedgerFact["provenance"] =>
  authority === "moltnet" || authority === "daimon" ? "agentic" : "mechanical";

/** One explicit room to render as an anchor — the generalized replacement for the old single-room `world` shape. */
export interface BuildRunWorldTraceRoomInput {
  networkId: string;
  roomId: string;
  members?: string[];
}

export interface BuildRunWorldTraceParams {
  runId: string;
  runName: string;
  /** Legacy single-room shape, kept for callers that only ever had one anchor. Ignored when `rooms` is given. */
  world?: { networkId?: string; roomId?: string; members?: string[] };
  /**
   * Explicit room list — the parameterization the recursive membrane portal
   * needs (`docs/VIEW_DESIGN.md` rule 5): the outer map's rooms (every
   * `manifest.world` room that is NOT some membrane's interior room) and a
   * membrane's own `interiorRooms` both go through this same param, laid out
   * side by side (`ROOM_SPACING` apart) rather than stacked at one origin.
   */
  rooms?: BuildRunWorldTraceRoomInput[];
  /** Defined only when the composed manifest + telemetry pass the strict spatial gate. */
  spatialWorld?: RunSpatialWorld;
  timeline: RunTimeline;
}

/** Deterministic x-offset between room anchors when more than one room is rendered — presentation only, never fed back into the schema (rule 4). */
const ROOM_SPACING = 3.2;

const qualifiedRoomId = (networkId: string, roomId: string): string => `room:${networkId}:${roomId}`;

export const buildRunWorldTrace = ({ runId, runName, world, rooms: roomInputs, spatialWorld, timeline }: BuildRunWorldTraceParams): RunWorldTrace => {
  if (spatialWorld) {
    return buildSpatialRunWorldTrace({
      runId,
      runName,
      spatialWorld,
      timeline,
      ledgerFacts: buildRunWorldLedgerFacts(timeline),
    });
  }

  const inputs: BuildRunWorldTraceRoomInput[] = roomInputs?.length
    ? roomInputs
    : [{ networkId: world?.networkId ?? "run", roomId: world?.roomId ?? "run-room", members: world?.members }];

  const allAgentLabels = timeline.elements.filter((element) => element.kind === "agent").map((element) => element.label);

  const rooms: RunWorldTraceRoom[] = inputs.map((input, index) => {
    // The "fall back to every agent in the timeline" rule only makes sense
    // for the single-anchor legacy shape; an explicit multi-room list always
    // states its own membership (an empty interior/outer room legitimately
    // has no members rather than borrowing every other room's agents).
    const members = input.members?.length ? input.members : inputs.length === 1 ? allAgentLabels : [];
    const id = qualifiedRoomId(input.networkId, input.roomId);
    return {
      id,
      kind: "room",
      label: input.roomId,
      scope: id,
      members,
      scene: [index * ROOM_SPACING, 0, 0],
      access_hint: NO_PLACE_CAPTION,
    };
  });

  const memberIds = new Set(rooms.flatMap((room) => room.members));
  const agents: RunWorldTraceAgent[] = [...memberIds].map((id) => ({
    id,
    label: id,
    scope: `agent:${id}`,
    label_hint: "heuristic",
    detail: "Placeless chat participant in this run — open its storyline portal for its own timeline.",
  }));

  const ledgerFacts: RunWorldTraceLedgerFact[] = timeline.events.map((event) => ({
    type: anchorLedgerFactType(event.viewClass),
    tick: event.t,
    event_id: event.eventId,
    kind: event.type,
    sim_time: event.t,
    provenance: provenanceFor(event.authority),
    actor: event.actor ?? event.authority,
    target: event.subjects[0] ?? "",
    detail: event.text ?? event.type,
    scope: event.subjects[0],
    payload: event.payload,
  }));

  return {
    version: "viewer.trace.v1",
    run_id: runId,
    run_name: runName,
    rooms,
    corridors: [],
    agents,
    presence: [],
    ledger_facts: ledgerFacts,
    signals: [],
    spatial_samples: [],
  };
};

const recordPayload = (payload: unknown): Record<string, unknown> =>
  typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};

const payloadString = (payload: Record<string, unknown>, key: string): string | undefined =>
  typeof payload[key] === "string" ? payload[key] : undefined;

export const buildRunWorldLedgerFacts = (timeline: RunTimeline): RunWorldTraceLedgerFact[] =>
  timeline.events.map((event) => {
    const payload = recordPayload(event.payload);
    const place = payloadString(payload, "place");
    const actor = payloadString(payload, "actor") ?? payloadString(payload, "agent") ?? event.actor ?? event.authority;
    const target = payloadString(payload, "target") ?? place ?? event.subjects[0] ?? "";
    const scope = payloadString(payload, "scope") ?? place ?? event.subjects[0];
    return {
      type: ledgerFactType(event.type, event.viewClass),
      tick: event.t,
      event_id: event.eventId,
      kind: event.type,
      sim_time: typeof payload.sim_time === "number" ? payload.sim_time : event.t,
      provenance: payload.provenance === "mechanical" || payload.provenance === "agentic" || payload.provenance === "external"
        ? payload.provenance
        : provenanceFor(event.authority),
      actor,
      target,
      detail: event.text ?? event.type,
      scope,
      payload: event.payload,
    };
  });

/**
 * Builds a `viewer.trace.v1` mini-map for every membrane, scoped to exactly
 * its own `interiorRooms` — the recursive membrane portal's interior map
 * (`docs/VIEW_DESIGN.md` rule 5, "descend into a mind"). Called once by
 * `server.ts` after the full `RunTimeline` (interior events included)
 * exists; membranes with no parseable interior room ref pass through
 * unchanged rather than throwing (defensive — every membrane
 * `deriveMembranes` emits today always has at least one, but a future
 * shape should degrade, not crash the server).
 */
export const buildMembraneInteriorWorlds = (
  membranes: readonly RunTimelineMembrane[],
  timeline: RunTimeline,
): RunTimelineMembrane[] =>
  membranes.map((membrane) => {
    const memberIds = membrane.members.map(stripRefPrefix);
    const rooms = membrane.interiorRooms
      .map(parseRoomRef)
      .filter((room): room is { networkId: string; roomId: string } => room !== undefined)
      .map((room) => ({ ...room, members: memberIds }));
    if (rooms.length === 0) return membrane;

    return {
      ...membrane,
      interiorWorld: buildRunWorldTrace({ runId: timeline.runId, runName: timeline.runId, rooms, timeline }),
    };
  });
