import type { RunTimeline, RunTimelineMembrane } from "./runTimelineTypes.js";
import { parseRoomRef, stripRefPrefix } from "./runTimelineRefs.js";

/**
 * Adapts a run-replay `RunTimeline` into the same `viewer.trace.v1` shape
 * `web/src/viewer/worldModel.ts`'s `buildViewerWorld` already consumes, so
 * the existing `AsciiMap`/`worldModel`/`renderSettings` render this run's
 * map unchanged (`VIEW_DESIGN.md`'s two-layer rule). This type is a
 * structural mirror of `web/src/viewer/types.ts`'s `ViewerContractTrace` —
 * a deliberate duplicate, not a cross-package import, matching this
 * package's existing src/web boundary: the contract is the JSON shape on
 * the wire, not a shared TS type.
 *
 * These moltnet-room runs have no place-bearing world (Space Module has not
 * landed): there is exactly one informational room anchor per room in the
 * `rooms` list, no corridors, no presence stream. Agents render with
 * `label_hint: "heuristic"`, which is the same "no presence stream yet"
 * treatment `worldModel.ts` already gives any agent lacking presence events
 * — nothing new to teach the renderer.
 */
export interface RunWorldTraceRoom {
  id: string;
  label: string;
  scope: string;
  members: string[];
  scene: [number, number, number];
  access_hint?: string;
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
  | "world.message"
  | "world.dm"
  | "wake.recommended"
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

export interface RunWorldTrace {
  version: "viewer.trace.v1";
  run_id: string;
  run_name: string;
  rooms: RunWorldTraceRoom[];
  corridors: never[];
  agents: RunWorldTraceAgent[];
  presence: never[];
  ledger_facts: RunWorldTraceLedgerFact[];
  signals: never[];
}

export const NO_PLACE_CAPTION =
  "no place-bearing world in this run — a chat-only room, rendered as an informational anchor";

const ledgerFactType = (viewClass: string): RunWorldTraceLedgerFactType => {
  if (viewClass === "message") return "world.message";
  if (viewClass === "wake") return "wake.recommended";
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
   * needs (`VIEW_DESIGN.md` rule 5): the outer map's rooms (every
   * `manifest.world` room that is NOT some membrane's interior room) and a
   * membrane's own `interiorRooms` both go through this same param, laid out
   * side by side (`ROOM_SPACING` apart) rather than stacked at one origin.
   */
  rooms?: BuildRunWorldTraceRoomInput[];
  timeline: RunTimeline;
}

/** Deterministic x-offset between room anchors when more than one room is rendered — presentation only, never fed back into the schema (rule 4). */
const ROOM_SPACING = 3.2;

export const buildRunWorldTrace = ({ runId, runName, world, rooms: roomInputs, timeline }: BuildRunWorldTraceParams): RunWorldTrace => {
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
    return {
      id: input.roomId,
      label: input.roomId,
      scope: `room:${input.networkId}:${input.roomId}`,
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
    type: ledgerFactType(event.viewClass),
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
  };
};

/**
 * Builds a `viewer.trace.v1` mini-map for every membrane, scoped to exactly
 * its own `interiorRooms` — the recursive membrane portal's interior map
 * (`VIEW_DESIGN.md` rule 5, "descend into a mind"). Called once by
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
