export const DYNAMICS_PROVIDER_API_VERSION = "simfile.dynamics-provider.v1" as const;
export const DYNAMICS_SNAPSHOT_VERSION = "simfile.dynamics-snapshot.v1" as const;
export const DYNAMICS_OBSERVATION_VERSION = "simfile.numeric-observation.v1" as const;

export type DynamicsJsonValue =
  | null
  | boolean
  | number
  | string
  | DynamicsJsonValue[]
  | DynamicsJsonObject;

export interface DynamicsJsonObject {
  [key: string]: DynamicsJsonValue;
}

export type ReadonlyDynamicsJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ReadonlyDynamicsJsonValue[]
  | ReadonlyDynamicsJsonObject;

export interface ReadonlyDynamicsJsonObject {
  readonly [key: string]: ReadonlyDynamicsJsonValue;
}

/** Portable identity for the trusted local module and its bound configuration. */
export interface DynamicsProvenance {
  api_version: typeof DYNAMICS_PROVIDER_API_VERSION;
  config_sha256: string;
  module: string;
  module_sha256: string;
  node_version: string;
  numeric_model: "ieee754-binary64";
  provider_dependencies: Record<string, string>;
  provider_id: string;
  provider_version: string;
  state_schema_version: string;
}

export interface DynamicsInitializeContext {
  readonly config: ReadonlyDynamicsJsonObject;
  readonly provenance: Readonly<DynamicsProvenance>;
  readonly seed: string;
  readonly sim_seconds_per_tick: number;
}

/**
 * Host-authenticated action envelope. Agent-facing tools must not let a model
 * supply actor, principal_id, at_tick, or origin directly.
 */
export interface DynamicsActionAttempt {
  act_id: string;
  action: string;
  actor: string;
  at_tick: number;
  input: DynamicsJsonObject;
  origin: "agentic" | "controller" | "external" | "replay";
  principal_id: string;
  target: string;
}

export interface DynamicsQueuedAction extends DynamicsActionAttempt {
  sequence: number;
}

/** Minimal immutable mechanical command; all authentication metadata stays host-side. */
export interface DynamicsCommand {
  readonly action: string;
  readonly actor: string;
  readonly input: ReadonlyDynamicsJsonObject;
  readonly sequence: number;
  readonly target: string;
}

export interface DynamicsActionQueueReceipt {
  act_id: string;
  apply_tick: number;
  code?: "act_id_conflict" | "wrong_tick";
  queued: boolean;
  sequence?: number;
}

/** The first canonical disposition of one principal-scoped action id. */
export interface DynamicsActionIngressRecord {
  attempt: DynamicsActionAttempt;
  receipt: DynamicsActionQueueReceipt;
}

/** Bounded identity retained after the complete ingress evidence is durable. */
export interface DynamicsActionIdempotencyRecord {
  act_id: string;
  at_tick: number;
  attempt_sha256: string;
  principal_id: string;
  retained_at_tick: number;
  receipt: DynamicsActionQueueReceipt;
}

/** Monotonic delivery identity for complete ingress evidence awaiting acknowledgment. */
export interface DynamicsActionIngressEvidence {
  ordinal: number;
  record: DynamicsActionIngressRecord;
}

/** All sequences below floor are members; above_floor holds later members. */
export interface DynamicsActionSequenceWatermark {
  floor: number;
  above_floor: number[];
}

/** A provider's mechanical decision for one command; the host stamps identity. */
export interface DynamicsActionResolution {
  accepted: boolean;
  code?: string;
  message?: string;
  sequence: number;
}

export interface DynamicsActionResult extends DynamicsActionResolution {
  act_id: string;
  action: string;
  actor: string;
  apply_tick: number;
  origin: DynamicsActionAttempt["origin"];
  principal_id: string;
  sequence: number;
  target: string;
}

/** Untrusted mechanical draft. Only the host assigns tick, ordering, and provenance. */
export interface DynamicsEventDraft {
  cause_action_sequences: number[];
  kind: string;
  payload: DynamicsJsonObject;
  source: string;
  target: string;
}

export interface DynamicsEvent extends DynamicsEventDraft {
  event_sequence: number;
  provenance: "mechanical";
  tick: number;
}

export type DynamicsCommitmentOutcomeStatus =
  | "fulfilled"
  | "expired"
  | "abandoned"
  | "matched"
  | "unmatched";

/**
 * Untrusted terminal commitment fact supplied by a mechanics provider.
 *
 * A commitment MAY be addressed to another participant: one participant
 * declares an expectation about the world to a second one before acting on it.
 * When it is, the record names that `counterparty` and the outcome states
 * whether the world afterwards matched the declared expectation (`matched`) or
 * did not (`unmatched`). The outcome is always the mechanics provider's own
 * derivation from observed state — never a claim made by either participant.
 */
export interface DynamicsCommitmentOutcomeDraft {
  readonly commitment_id: string;
  /** The participant the expectation was declared to, when it was addressed. */
  readonly counterparty?: string;
  readonly declaration_action_sequence: number;
  readonly outcome: DynamicsCommitmentOutcomeStatus;
  readonly participant: string;
}

export interface DynamicsCommitmentOutcome
  extends DynamicsCommitmentOutcomeDraft {
  readonly provenance: "mechanical";
  readonly tick: number;
}

export interface DynamicsStepInput {
  readonly actions: readonly DynamicsCommand[];
  readonly dt_seconds: number;
  readonly sim_time: number;
  readonly tick: number;
}

export interface DynamicsProviderStepResult {
  action_results: DynamicsActionResolution[];
  commitment_outcomes?: DynamicsCommitmentOutcomeDraft[];
  events: DynamicsEventDraft[];
  tick: number;
}

export interface DynamicsStepResult {
  action_results: DynamicsActionResult[];
  commitment_outcomes?: DynamicsCommitmentOutcome[];
  events: DynamicsEvent[];
  tick: number;
}

/** Exact sense-address grants, already resolved by the trusted host. */
export interface DynamicsObservationRequest {
  observer: string;
  principal_id: string;
  sense_addresses: string[];
}

/** Providers receive no caller identity, only the exact granted sense ports. */
export interface DynamicsProviderObservationRequest {
  readonly sense_addresses: readonly string[];
  readonly sim_time: number;
  readonly tick: number;
}

export interface DynamicsObservationChannel {
  components: Record<string, number>;
  frame?: string;
  sense_address: string;
  subject_address: string;
  unit?: string;
}

export interface DynamicsProviderObservation {
  channels: DynamicsObservationChannel[];
}

export interface DynamicsObservation extends DynamicsProviderObservation {
  observer: string;
  principal_id: string;
  tick: number;
  version: typeof DYNAMICS_OBSERVATION_VERSION;
}

/**
 * One spatial body in a provider's per-tick scene projection. Deliberately
 * genre-neutral: an id, a 2D position, and a velocity — nothing that names a
 * ball, a player, a room, or any other domain noun. Generic host code must be
 * able to record and render this without learning a provider's vocabulary.
 */
export interface DynamicsSpatialObject {
  id: string;
  position: [number, number];
  /**
   * World units per SECOND (not per tick). The viewer's Hermite interpolation
   * multiplies this by the sample's duration in seconds
   * (`web/src/viewer/spatialObjectModel.ts`), and its implicit-discontinuity
   * check compares a per-second sampled speed against these endpoint speeds —
   * so an under-reported velocity makes fast motion freeze and teleport.
   */
  velocity: [number, number];
}

/**
 * A provider's optional per-tick spatial projection: the one seam by which
 * opaque `provider_state` surfaces renderable motion to generic host code.
 * `bounds` is the constant scene extent (min/max corners) and only needs to be
 * reported once per run; the host records the first one it sees.
 */
export interface DynamicsSpatialFrame {
  bounds?: { max: [number, number]; min: [number, number] };
  objects: DynamicsSpatialObject[];
}

/**
 * A synchronous trusted-code mechanics provider. Provider modules execute in
 * the host process with no sandbox. The executed artifact digest seals bundled
 * project and package code; the separate build receipt records its complete
 * source closure and allowlisted runtime externals.
 *
 * All behavior-affecting mutable state must live in the provider instance and
 * round-trip through snapshot()/restore(); mutable module-global or transitive
 * singleton state is forbidden. Each load freshly evaluates the complete
 * bundle. observe() and snapshot() must be pure. Provider behavior must be
 * deterministic from initialize/step inputs alone: use the supplied seed and
 * simulated time, never Date, Math.random, hidden async work,
 * network/filesystem state, or other external side effects.
 */
export interface DynamicsProvider {
  api_version: typeof DYNAMICS_PROVIDER_API_VERSION;
  dependencies?: Record<string, string>;
  id: string;
  integration?: ReadonlyDynamicsJsonObject;
  state_schema_version: string;
  version: string;
  initialize(context: DynamicsInitializeContext): void;
  observe(request: DynamicsProviderObservationRequest): DynamicsProviderObservation;
  restore(snapshot: DynamicsJsonValue): void;
  snapshot(): DynamicsJsonValue;
  /**
   * Optional per-tick scene projection, used only to record a renderable
   * motion track. Must be pure and deterministic like `observe()` — the host
   * enforces that by snapshot-comparing around the call. A provider that omits
   * it simply records no motion: the host degrades, never throws, and never
   * fabricates positions. Optional and absence-degrading by design, so adding
   * it needs no `api_version` bump.
   */
  spatial?(): DynamicsSpatialFrame;
  step(input: DynamicsStepInput): DynamicsProviderStepResult;
}

export interface DynamicsProviderModule {
  createDynamicsProvider(): DynamicsProvider;
}

/**
 * Checkpoint for the dynamics session only. Whole-world checkpoints must also
 * preserve Simfile variables, presence, rule/condition state, and ledger cursors.
 */
export interface DynamicsSessionSnapshot {
  accepted_action_sequences: DynamicsActionSequenceWatermark;
  action_ingress: DynamicsActionIdempotencyRecord[];
  action_ingress_floor: number;
  action_ingress_ordinal: number;
  next_action_sequence: number;
  next_event_sequence: number;
  next_tick: number;
  pending_actions: DynamicsQueuedAction[];
  provider_state: DynamicsJsonValue;
  provenance: DynamicsProvenance;
  resolved_action_sequences: DynamicsActionSequenceWatermark;
  seed: string;
  sim_seconds_per_tick: number;
  version: typeof DYNAMICS_SNAPSHOT_VERSION;
}
