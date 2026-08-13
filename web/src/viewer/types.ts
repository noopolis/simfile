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
   * `team` remains part of the renderer's genre-neutral node vocabulary.
   * Membrane descent does not synthesize one: its affordance is carried by
   * the representative's own `agent` node (`VIEW_DESIGN.md` rule 5).
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
  geometry?: "cube" | "sphere";
  /** Viewer-owned, tick-relative movement state; never part of the trace contract. */
  in_transit?: boolean;
  transit_heading?: number;
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
  /** Public ingestion lifecycle; omitted by older and non-live producers. */
  playback_status?: "live" | "completed" | "failed";
  rooms: ViewerTraceRoom[];
  corridors: ViewerTraceCorridor[];
  agents: ViewerTraceAgent[];
  presence: ViewerPresenceEvent[];
  ledger_facts: ViewerLedgerFact[];
  /** Bounded producer-authored public facts for the selected node. */
  inspections?: ViewerTraceInspection[];
  /** Bounded, redacted inspector changes keyed to the replay cursor. */
  inspection_samples?: ViewerTraceInspectionSample[];
  signals: ViewerSignal[];
  /** Full spatial state at each runtime tick. Optional for older/chat-only traces. */
  spatial_samples?: ViewerSpatialSample[];
  /** Authoritative simulated milliseconds represented by one tick. */
  tick_duration_ms?: number;
  /** Opaque extension-owned presentation data keyed by extension id. */
  viewer_extension_data?: Readonly<Record<string, unknown>>;
  viewer_extensions?: readonly Readonly<{
    id: string;
    status: "recorded" | "unsealed/local";
  }>[];
}

export interface ViewerTraceRoom {
  id: string;
  kind?: "room" | "square";
  label: string;
  scope: string;
  members: string[];
  scene: [number, number, number];
  scale?: [number, number];
  wall_height?: number;
  access_hint?: string;
  place_id?: string;
}

export interface ViewerTraceCorridor {
  direction?: "bidirectional" | "one_way";
  id: string;
  from_room: string;
  to_room: string;
  path: ViewerPathPoint[];
  width?: number;
  travel_ticks?: number;
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
  type: "clock.sync" | "presence.arrived" | "presence.left" | "world.message" | "world.dm" | "wake.recommended" | "rule.fired" | "marker.seen" | "probe" | "other";
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
  geometry?: "cube" | "sphere";
  kind: "variable" | "marker" | "probe";
  id: string;
  scope: string;
  label: string;
  value: string;
  detail: string;
  scene: [number, number, number];
  scale?: number | [number, number, number];
}

export interface ViewerEventRow {
  time: string;
  type: string;
  actor: string;
  target: string;
  detail: string;
}

export interface ViewerDerivedWorld {
  inspectionsByNode: Record<string, ViewerTraceInspection>;
  inspectionSamples: ViewerTraceInspectionSample[];
  nodes: ViewerNode[];
  roomGeometries: RoomGeometry[];
  roomPaths: RoomPath[];
  ledgerRows: ViewerEventRow[];
  presenceByAgent: Record<string, ViewerPresenceEvent[]>;
  spatialSamples: ViewerSpatialSample[];
  tickDurationMs: number;
  viewerExtensionData?: Readonly<Record<string, unknown>>;
  viewerExtensionIdentities?: ViewerContractTrace["viewer_extensions"];
}

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
  /** Exact world-space samples; omitted by chat-only traces. */
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

export interface ViewerTraceInspection {
  fields: ViewerInspectionField[];
  node_id: string;
}

export interface ViewerTraceInspectionSample {
  inspections: ViewerTraceInspection[];
  tick: number;
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
