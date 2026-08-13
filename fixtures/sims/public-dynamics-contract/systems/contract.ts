import type {
  DynamicsActionAttempt,
  DynamicsActionIngressEvidence,
  DynamicsActionQueueReceipt,
  DynamicsActionResolution,
  DynamicsActionResult,
  DynamicsBuildArtifactLifecycle,
  DynamicsCommitmentOutcomeDraft,
  DynamicsEvent,
  DynamicsEventDraft,
  DynamicsJsonObject,
  DynamicsJsonValue,
  DynamicsObservation,
  DynamicsObservationChannel,
  DynamicsObservationRequest,
  DynamicsProvider,
  DynamicsProviderObservation,
  DynamicsProvenance,
  DynamicsRunActionSourceInitialization,
  DynamicsRunActionSourceTick,
  DynamicsRunControllerAction,
  DynamicsSession,
  DynamicsSessionSnapshot,
  DynamicsSpatialFrame,
  DynamicsStepResult,
  PreparedDynamicsBuild,
  ReadonlyDynamicsJsonObject,
  WorldAffordanceLoweringInput,
  WorldMechanicsResult,
  WorldSenseProjectionInput,
  WorldSurfaceDefinition
} from "simfile/dynamics";

export type PublicDynamicsB108Types = {
  action: DynamicsActionAttempt;
  commitmentOutcome: DynamicsCommitmentOutcomeDraft;
  evidence: DynamicsActionIngressEvidence;
  lifecycle: DynamicsBuildArtifactLifecycle;
  queue: DynamicsActionQueueReceipt;
  result: DynamicsActionResult;
  event: DynamicsEvent;
  observation: DynamicsObservation;
  observationRequest: DynamicsObservationRequest;
  prepared: PreparedDynamicsBuild;
  provenance: DynamicsProvenance;
  runActionSourceInitialization: DynamicsRunActionSourceInitialization;
  runActionSourceTick: DynamicsRunActionSourceTick;
  runControllerAction: DynamicsRunControllerAction;
  session: DynamicsSession;
  snapshot: DynamicsSessionSnapshot;
  spatial: DynamicsSpatialFrame;
  step: DynamicsStepResult;
};

export const acknowledgePublicDynamicsIngress = (
  session: DynamicsSession,
  afterOrdinal: number
): readonly DynamicsActionIngressEvidence[] => {
  const evidence = session.readActionIngressEvidence(afterOrdinal);
  const final = evidence.at(-1);
  if (final !== undefined) session.acknowledgeActionIngressEvidence(final.ordinal);
  return evidence;
};

const emptyObject = (): DynamicsJsonObject => ({});

const lower = (_input: WorldAffordanceLoweringInput): DynamicsJsonObject => emptyObject();

const projectResult = (result: WorldMechanicsResult): DynamicsJsonObject => ({
  accepted: result.accepted
});

const projectSense = (input: WorldSenseProjectionInput): DynamicsProviderObservation => {
  const channel: DynamicsObservationChannel = {
    components: { value: 0 },
    sense_address: "sense:counter",
    subject_address: input.holder
  };
  return { channels: [channel] };
};

export const createDynamicsProvider = (): DynamicsProvider => {
  let state: DynamicsJsonValue = { value: 0 };
  return {
    api_version: "simfile.dynamics-provider.v1",
    id: "public-contract-counter",
    integration: { model: "counter" },
    state_schema_version: "public-contract-counter.v1",
    version: "1.0.0",
    initialize(context) {
      const config: ReadonlyDynamicsJsonObject = context.config;
      state = { value: typeof config.initial === "number" ? config.initial : 0 };
    },
    observe() {
      return { channels: [] };
    },
    restore(snapshot) {
      state = snapshot;
    },
    snapshot() {
      return state;
    },
    // The optional per-tick scene projection. Exercised here to prove the
    // seam type-checks against the PUBLIC `DynamicsProvider` and needs no
    // genre vocabulary: an id, a position, a velocity, and nothing else.
    // A provider omitting this stays valid — absence records no motion.
    spatial(): DynamicsSpatialFrame {
      const value = typeof state === "object" && state !== null && !Array.isArray(state)
        && typeof state.value === "number" ? state.value : 0;
      return {
        bounds: { max: [1, 1], min: [-1, -1] },
        objects: [{ id: "object:counter", position: [value, 0], velocity: [0, 0] }]
      };
    },
    step(input) {
      const action_results: DynamicsActionResolution[] = input.actions.map((action) => ({
        accepted: false,
        code: "unsupported_action",
        sequence: action.sequence
      }));
      const events: DynamicsEventDraft[] = [];
      return { action_results, events, tick: input.tick };
    }
  };
};

export const createWorldSurfaceDefinition = (): WorldSurfaceDefinition => ({
  api_version: "simfile.world-surface.v1",
  affordances: {
    "affordance:increment": {
      available: () => true,
      dynamics_action: "increment",
      input_schema: {
        additionalProperties: false,
        properties: {},
        type: "object"
      },
      lower,
      project_result: projectResult,
      rejection_codes: ["unsupported_action"],
      target_selector: { kind: "holder" }
    }
  },
  effects: {},
  entities: {
    counter: { address: "entity:counter", dynamics_address: "object:counter" }
  },
  senses: {
    "sense:counter": {
      dynamics_senses: ["sense:counter"],
      output: "simfile.numeric-observation.v1",
      project: projectSense
    }
  }
});
