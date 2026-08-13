import type { MarkerCoverageResult } from "../ledger/markers.js";
import type { ProbeEvaluationResult } from "../report/probes.js";
import type { Simfile } from "../schema/model.js";
import type { RuntimeTrace, RuntimeTraceEvent } from "./types.js";
import {
  buildViewerAgents,
  buildViewerCorridors,
  buildViewerPresence,
  buildViewerRooms,
  buildViewerSpatialSamples
} from "./viewer-spatial.js";

export interface ViewerTraceRoom {
  id: string;
  kind: "room" | "square";
  label: string;
  members: string[];
  place_id?: string;
  scene: [number, number, number];
  scale?: [number, number];
  scope: string;
}

export interface ViewerTraceCorridor {
  direction?: "bidirectional" | "one_way";
  from_room: string;
  id: string;
  path: Array<{ x: number; y: number }>;
  to_room: string;
  travel_ticks?: number;
  width?: number;
}

export interface ViewerTraceAgent {
  detail?: string;
  id: string;
  label?: string;
  label_hint?: string;
  scope: string;
}

export interface ViewerTraceFact {
  actor: string;
  detail: string;
  event_id: string;
  kind: string;
  payload: RuntimeTraceEvent["payload"];
  provenance: RuntimeTraceEvent["provenance"];
  scope?: string;
  sim_time: number;
  target: string;
  tick: number;
  type: "clock.sync" | "presence.arrived" | "presence.left" | "world.message" | "world.dm" | "rule.fired" | "marker.seen" | "probe" | "other";
}

export interface ViewerPresenceArrived {
  actor: string;
  room: string;
  tick: number;
  type: "presence.arrived";
}

export interface ViewerPresenceDeparted {
  actor: string;
  from_room: string;
  path_id: string;
  tick: number;
  to_room: string;
  type: "presence.departed";
}

export interface ViewerPresenceInTransit {
  actor: string;
  arrived_at: number;
  from_room: string;
  path_id: string;
  started_at: number;
  tick: number;
  to_room: string;
  type: "presence.in_transit";
}

export type ViewerPresence = ViewerPresenceArrived | ViewerPresenceDeparted | ViewerPresenceInTransit;

export interface ViewerSpatialTransit {
  agent: string;
  from_room: string;
  path_id: string;
  ticks_remaining: number;
  to_room: string;
}

export interface ViewerSpatialSample {
  /** Object ids that cut directly to this authoritative sample. */
  discontinuities?: string[];
  occupancy: Record<string, string[]>;
  /** Optional exact positions for place-bearing world objects at this tick. */
  objects?: ViewerSpatialObjectSample[];
  tick: number;
  transit: ViewerSpatialTransit[];
}

export interface ViewerSpatialObjectSample {
  id: string;
  position: [number, number];
  /** World units per authoritative simulation tick. */
  velocity?: [number, number];
}

export interface ViewerInspectionField {
  label: string;
  value: string;
}

/**
 * A bounded, already-redacted inspector projection. Producers decide which
 * public facts exist; the viewer never reaches behind this projection.
 */
export interface ViewerTraceInspection {
  fields: ViewerInspectionField[];
  node_id: string;
}

/**
 * Optional public inspector snapshots for replay cursors. Producers emit only
 * redacted changes, so the viewer never reaches behind this projection.
 */
export interface ViewerTraceInspectionSample {
  inspections: ViewerTraceInspection[];
  tick: number;
}

export interface ViewerTraceSignal {
  detail: string;
  geometry?: "cube" | "sphere";
  id: string;
  kind: "variable" | "marker" | "probe";
  label: string;
  scene: [number, number, number];
  scale?: number | [number, number, number];
  scope: string;
  value: string;
}

export interface ViewerContractTrace {
  agents: ViewerTraceAgent[];
  corridors: ViewerTraceCorridor[];
  ledger_facts: ViewerTraceFact[];
  /** Public ingestion lifecycle; omitted by older and non-live producers. */
  playback_status?: "live" | "completed" | "failed";
  /** Optional bounded, already-redacted terminal diagnostic from the producer. */
  terminal_detail?: string;
  inspections?: ViewerTraceInspection[];
  inspection_samples?: ViewerTraceInspectionSample[];
  presence: ViewerPresence[];
  rooms: ViewerTraceRoom[];
  run_id: string;
  run_name: string;
  signals: ViewerTraceSignal[];
  spatial_samples: ViewerSpatialSample[];
  /** Authoritative simulated milliseconds represented by one tick. */
  tick_duration_ms?: number;
  version: "viewer.trace.v1";
}

const contentDetail = (event: RuntimeTraceEvent): string => {
  const payload = typeof event.payload === "object" && event.payload !== null
    ? event.payload as Record<string, unknown>
    : {};
  const content = payload.content;
  if (typeof content === "string") {
    return content;
  }
  const reason = payload.reason;
  if (typeof reason === "string") {
    return reason;
  }
  return event.kind;
};

const tickForEvent = (trace: RuntimeTrace, event: RuntimeTraceEvent): number => {
  const matching = trace.samples.find((sample) => sample.sim_time === event.sim_time);
  return matching?.tick ?? 0;
};

const factType = (kind: string): ViewerTraceFact["type"] => {
  if (
    kind === "clock.sync"
    || kind === "presence.arrived"
    || kind === "presence.left"
    || kind === "world.message"
    || kind === "world.dm"
    || kind === "rule.fired"
    || kind === "marker.seen"
  ) {
    return kind;
  }
  return "other";
};

const buildFacts = (trace: RuntimeTrace): ViewerTraceFact[] =>
  trace.events.map((event) => ({
    actor: event.actor,
    detail: contentDetail(event),
    event_id: event.event_id,
    kind: event.kind,
    payload: event.payload,
    provenance: event.provenance,
    scope: event.scope,
    sim_time: event.sim_time,
    target: event.target,
    tick: tickForEvent(trace, event),
    type: factType(event.kind)
  }));

const buildSignals = (
  simfile: Simfile,
  trace: RuntimeTrace,
  markers: readonly MarkerCoverageResult[],
  probes: readonly ProbeEvaluationResult[],
  rooms: readonly ViewerTraceRoom[]
): ViewerTraceSignal[] => {
  const roomByScope = new Map(rooms.map((room) => [room.scope, room.scene]));
  const signalAt = (scope: string, offset: number): [number, number, number] => {
    const [x, y] = roomByScope.get(scope) ?? [0, 0, 0];
    return [x + offset, y - 0.8, 0.58];
  };
  const variables = Object.entries(simfile.variables).map(([id, variable], index) => ({
    detail: "Final variable value from runtime samples.",
    id,
    kind: "variable" as const,
    label: id,
    scene: signalAt(variable.scope, index * 0.22),
    scope: variable.scope,
    value: String(trace.variables[id] ?? 0)
  }));
  const markerSignals = markers.map((marker, index) => ({
    detail: marker.detail,
    id: marker.markerId,
    kind: "marker" as const,
    label: marker.markerId,
    scene: signalAt(simfile.markers[marker.markerId]?.scopes[0] ?? "global", index * 0.22),
    scope: simfile.markers[marker.markerId]?.scopes[0] ?? "global",
    value: marker.passed ? "pass" : "fail"
  }));
  const probeSignals = probes.map((probe, index) => ({
    detail: `${probe.count} matching event(s)`,
    id: probe.probeId,
    kind: "probe" as const,
    label: probe.probeId,
    scene: [index * 0.26, -1.8, 0.58] as [number, number, number],
    scope: `probe:${probe.probeId}`,
    value: probe.passed ? "pass" : "fail"
  }));
  return [...variables, ...markerSignals, ...probeSignals];
};

export const buildViewerTrace = (
  simfile: Simfile,
  trace: RuntimeTrace,
  markers: readonly MarkerCoverageResult[],
  probes: readonly ProbeEvaluationResult[]
): ViewerContractTrace => {
  const rooms = buildViewerRooms(simfile, trace);
  const corridors = buildViewerCorridors(simfile, rooms);
  return {
    agents: buildViewerAgents(simfile, trace),
    corridors,
    ledger_facts: buildFacts(trace),
    presence: buildViewerPresence(simfile, trace),
    rooms,
    run_id: trace.runId,
    run_name: simfile.name,
    signals: buildSignals(simfile, trace, markers, probes, rooms),
    spatial_samples: buildViewerSpatialSamples(simfile, trace),
    version: "viewer.trace.v1"
  };
};
