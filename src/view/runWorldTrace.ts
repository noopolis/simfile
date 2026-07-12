import type { RunTimeline } from "./runTimelineTypes.js";

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
 * landed): there is exactly one informational room anchor, no corridors, no
 * presence stream. Agents render with `label_hint: "heuristic"`, which is
 * the same "no presence stream yet" treatment `worldModel.ts` already gives
 * any agent lacking presence events — nothing new to teach the renderer.
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

export interface BuildRunWorldTraceParams {
  runId: string;
  runName: string;
  world?: { networkId?: string; roomId?: string; members?: string[] };
  timeline: RunTimeline;
}

export const buildRunWorldTrace = ({ runId, runName, world, timeline }: BuildRunWorldTraceParams): RunWorldTrace => {
  const roomId = world?.roomId ?? "run-room";
  const networkId = world?.networkId ?? "run";
  const members = world?.members?.length
    ? world.members
    : timeline.elements.filter((element) => element.kind === "agent").map((element) => element.label);

  const room: RunWorldTraceRoom = {
    id: roomId,
    label: roomId,
    scope: `room:${networkId}:${roomId}`,
    members,
    scene: [0, 0, 0],
    access_hint: NO_PLACE_CAPTION,
  };

  const agents: RunWorldTraceAgent[] = members.map((id) => ({
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
    rooms: [room],
    corridors: [],
    agents,
    presence: [],
    ledger_facts: ledgerFacts,
    signals: [],
  };
};
