/** @returns {import("simfile/dynamics").DynamicsProvider} */
export const createDynamicsProvider = () => {
  let value = 0;
  return {
    api_version: "simfile.dynamics-provider.v1",
    id: "composed-development-counter",
    integration: { model: "counter" },
    state_schema_version: "composed-development-counter.v1",
    version: "1.0.0",
    /** @param {import("simfile/dynamics").DynamicsInitializeContext} context */
    initialize(context) {
      value = typeof context.config.initial === "number"
        ? context.config.initial
        : 0;
    },
    /** @param {import("simfile/dynamics").DynamicsProviderObservationRequest} request */
    observe(request) {
      return {
        channels: request.sense_addresses.map((sense) => ({
          components: { value },
          sense_address: sense,
          subject_address: "object:counter",
        })),
      };
    },
    /** @param {import("simfile/dynamics").DynamicsJsonValue} snapshot */
    restore(snapshot) {
      if (snapshot === null || typeof snapshot !== "object"
        || Array.isArray(snapshot) || typeof snapshot.value !== "number") {
        throw new TypeError("composed development snapshot is invalid");
      }
      value = snapshot.value;
    },
    snapshot() {
      return { value };
    },
    spatial() {
      return {
        bounds: { max: [8, 1], min: [0, -1] },
        objects: [{
          id: "object:counter",
          position: [value, 0],
          velocity: [1, 0],
        }],
      };
    },
    /** @param {import("simfile/dynamics").DynamicsStepInput} input */
    step(input) {
      const action_results = input.actions.map((action) => ({
        accepted: false,
        code: "unsupported_action",
        sequence: action.sequence,
      }));
      value += input.dt_seconds;
      return { action_results, events: [], tick: input.tick };
    },
  };
};
