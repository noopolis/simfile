import type { MarkerCoverageResult } from "../ledger/markers.js";
import type { ProbeEvaluationResult } from "../report/probes.js";
import type { Simfile } from "../schema/model.js";
import type { RuntimeTrace, RuntimeTraceEvent } from "./types.js";

export interface ViewerTraceRoom {
  id: string;
  label: string;
  members: string[];
  scene: [number, number, number];
  scale?: [number, number];
  scope: string;
}

export interface ViewerTraceCorridor {
  from_room: string;
  id: string;
  path: Array<{ x: number; y: number }>;
  to_room: string;
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
  type: "clock.sync" | "world.message" | "world.dm" | "wake.recommended" | "rule.fired" | "marker.seen" | "probe" | "other";
}

export interface ViewerTraceSignal {
  detail: string;
  id: string;
  kind: "variable" | "marker" | "probe";
  label: string;
  scene: [number, number, number];
  scope: string;
  value: string;
}

export interface ViewerContractTrace {
  agents: ViewerTraceAgent[];
  corridors: ViewerTraceCorridor[];
  ledger_facts: ViewerTraceFact[];
  presence: [];
  rooms: ViewerTraceRoom[];
  run_id: string;
  run_name: string;
  signals: ViewerTraceSignal[];
  version: "viewer.trace.v1";
}

const roomScopePattern = /^room:([^:]+):([^:]+)$/u;
const agentScopePattern = /^agent:([^:]+)$/u;

const roomIdFromScope = (scope: string): string | undefined => scope.match(roomScopePattern)?.[2];
const agentIdFromScope = (scope: string): string | undefined => scope.match(agentScopePattern)?.[1];

const roomScopesFromEvent = (event: RuntimeTraceEvent): string[] =>
  [event.scope, event.target].filter((scope): scope is string => roomScopePattern.test(scope));

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

const sceneForIndex = (index: number, count: number): [number, number, number] => {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const row = Math.floor(index / cols);
  const col = index % cols;
  const x = (col - (cols - 1) / 2) * 2.4;
  const y = (row - Math.max(0, Math.ceil(count / cols) - 1) / 2) * 1.85;
  return [Number(x.toFixed(2)), Number(y.toFixed(2)), 0];
};

const buildRooms = (simfile: Simfile, trace: RuntimeTrace): ViewerTraceRoom[] => {
  const scopes = new Set<string>();
  for (const variable of Object.values(simfile.variables)) {
    if (roomScopePattern.test(variable.scope)) scopes.add(variable.scope);
  }
  for (const marker of Object.values(simfile.markers)) {
    for (const scope of marker.scopes) if (roomScopePattern.test(scope)) scopes.add(scope);
  }
  for (const event of trace.events) {
    for (const scope of roomScopesFromEvent(event)) scopes.add(scope);
  }

  return [...scopes].sort().map((scope, index, all) => {
    const id = roomIdFromScope(scope) ?? `room-${index}`;
    return {
      id,
      label: id,
      members: [],
      scene: sceneForIndex(index, all.length),
      scale: [1.4, 0.9],
      scope
    };
  });
};

const buildCorridors = (rooms: readonly ViewerTraceRoom[]): ViewerTraceCorridor[] =>
  rooms.slice(1).map((room, index) => {
    const from = rooms[index]!;
    const [ax, ay] = from.scene;
    const [bx, by] = room.scene;
    return {
      from_room: from.id,
      id: `${from.id}--${room.id}`,
      path: [
        { x: ax, y: ay },
        { x: bx, y: ay },
        { x: bx, y: by }
      ],
      to_room: room.id,
      width: 0.08
    };
  });

const buildAgents = (trace: RuntimeTrace): ViewerTraceAgent[] => {
  const agents = new Set<string>();
  for (const event of trace.events) {
    const target = agentIdFromScope(event.target);
    if (target) agents.add(target);
    if (event.provenance === "agentic" && event.actor !== "@world") agents.add(event.actor);
  }
  return [...agents].sort().map((id) => ({
    detail: "Heuristic placement: trace has this agent but no presence stream yet.",
    id,
    label: id,
    label_hint: "heuristic",
    scope: `agent:${id}`
  }));
};

const factType = (kind: string): ViewerTraceFact["type"] => {
  if (
    kind === "clock.sync"
    || kind === "world.message"
    || kind === "world.dm"
    || kind === "wake.recommended"
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
  const rooms = buildRooms(simfile, trace);
  return {
    agents: buildAgents(trace),
    corridors: buildCorridors(rooms),
    ledger_facts: buildFacts(trace),
    presence: [],
    rooms,
    run_id: trace.runId,
    run_name: simfile.name,
    signals: buildSignals(simfile, trace, markers, probes, rooms),
    version: "viewer.trace.v1"
  };
};
