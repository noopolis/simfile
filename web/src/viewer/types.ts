export interface ViewerState {
  /** `run-replay` selects `RunReplayShell` instead of this app's own world console (see `main.tsx`). */
  mode: "live" | "replay" | "run-replay";
  sourcePath: string;
  statePath?: string;
  now: string;
}

export type Vec3 = [number, number, number];

export interface SkinOption {
  id: string;
  label: string;
}

export interface SkinResponse {
  selected: string;
  options: SkinOption[];
}

export interface ViewerEvent {
  type: string;
  tick?: number;
  at?: string;
  actor?: string;
  target?: string;
  message?: string;
  detail?: string;
}

export interface ViewerNode {
  id: string;
  label: string;
  /**
   * `team` is a synthesized map node (`RunReplayShell.tsx`'s
   * `withMembraneNodes`, never emitted by any server trace): the descendable
   * self-membrane body next to its representative's own body — clicking it
   * calls `focusAndOpenPortal(membrane.ref)` directly (`VIEW_DESIGN.md`
   * rule 5, "the luna team node on the map").
   */
  kind: "room" | "agent" | "org" | "marker" | "variable" | "probe" | "event" | "team";
  scope: string;
  subtitle: string;
  detail: string;
  value: string;
  x: number;
  y: number;
  camera: [number, number];
  scene: [number, number, number];
  scale: [number, number, number] | number;
  colorRole: ViewerColorRole;
}

export type ViewerNodeKind = ViewerNode["kind"];

export type ViewerColorRole =
  | "room"
  | "agent"
  | "pressure"
  | "variable"
  | "marker"
  | "probe"
  | "world"
  | "floor"
  | "wall"
  | "path";

export interface ViewerContractTrace {
  version: "viewer.trace.v1";
  run_id: string;
  run_name: string;
  rooms: ViewerTraceRoom[];
  corridors: ViewerTraceCorridor[];
  agents: ViewerTraceAgent[];
  presence: ViewerPresenceEvent[];
  ledger_facts: ViewerLedgerFact[];
  signals: ViewerSignal[];
}

export interface ViewerTraceRoom {
  id: string;
  label: string;
  scope: string;
  members: string[];
  scene: [number, number, number];
  scale?: [number, number];
  wall_height?: number;
  access_hint?: string;
}

export interface ViewerTraceCorridor {
  id: string;
  from_room: string;
  to_room: string;
  path: ViewerPathPoint[];
  width?: number;
}

export interface ViewerPathPoint {
  x: number;
  y: number;
}

export interface ViewerTraceAgent {
  id: string;
  label?: string;
  scope: string;
  label_hint?: string;
  detail?: string;
}

export interface ViewerPresenceEventBase {
  type: string;
  actor: string;
  tick: number;
}

export interface ViewerPresenceDepartedEvent extends ViewerPresenceEventBase {
  type: "presence.departed";
  from_room: string;
  to_room: string;
  path_id: string;
}

export interface ViewerPresenceInTransitEvent extends ViewerPresenceEventBase {
  type: "presence.in_transit";
  from_room: string;
  to_room: string;
  path_id: string;
  started_at: number;
  arrived_at: number;
}

export interface ViewerPresenceArrivedEvent extends ViewerPresenceEventBase {
  type: "presence.arrived";
  room: string;
}

export type ViewerPresenceEvent =
  | ViewerPresenceDepartedEvent
  | ViewerPresenceInTransitEvent
  | ViewerPresenceArrivedEvent;

export interface ViewerLedgerFact {
  type: "clock.sync" | "world.message" | "world.dm" | "wake.recommended" | "rule.fired" | "marker.seen" | "probe" | "other";
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

export interface ViewerSignal {
  kind: "variable" | "marker" | "probe";
  id: string;
  scope: string;
  label: string;
  value: string;
  detail: string;
  scene: [number, number, number];
}

export interface ViewerEventRow {
  time: string;
  type: string;
  actor: string;
  target: string;
  detail: string;
}

export interface ViewerDerivedWorld {
  nodes: ViewerNode[];
  roomGeometries: RoomGeometry[];
  roomPaths: RoomPath[];
  ledgerRows: ViewerEventRow[];
  presenceByAgent: Record<string, ViewerPresenceEvent[]>;
}

export interface ViewerWorldResponse {
  now: string;
  run_id: string;
  run_name: string;
  trace: ViewerContractTrace;
}

export interface ViewerWorldErrorResponse {
  error: string;
  mode?: "live" | "replay";
  source_path?: string;
  required_artifacts?: string[];
  missing_artifacts?: string[];
}

export interface RoomGeometry {
  id: string;
  node: ViewerNode;
  access: string[];
  center: [number, number, number];
  size: [number, number];
  wallHeight: number;
  doorCutters: Record<WallSide, Array<[number, number]>>;
}

export type WallSide = "north" | "south" | "west" | "east";

export interface RoomPath {
  id: string;
  from: RoomGeometry;
  to: RoomGeometry;
  path: [number, number, number][];
  width: number;
}
