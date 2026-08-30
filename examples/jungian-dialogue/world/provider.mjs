/** @returns {import("simfile/dynamics").DynamicsProvider} */
export const createDynamicsProvider = () => {
  let elapsedSeconds = 0;
  let dream = {};
  return {
    api_version: "simfile.dynamics-provider.v1",
    id: "jungian-dialogue-dream",
    integration: { model: "fixed-symbolic-dream" },
    state_schema_version: "jungian-dialogue-dream.v1",
    version: "1.0.0",
    initialize(context) {
      dream = Object.fromEntries(Object.entries(context.config).filter(
        ([, value]) => typeof value === "number",
      ));
      elapsedSeconds = 0;
    },
    observe(request) {
      return {
        channels: request.sense_addresses.map((sense) => ({
          components: { ...dream },
          sense_address: sense,
          subject_address: "object:dream",
        })),
      };
    },
    restore(snapshot) {
      if (snapshot === null || typeof snapshot !== "object"
        || Array.isArray(snapshot)
        || typeof snapshot.elapsed_seconds !== "number"
        || snapshot.dream === null || typeof snapshot.dream !== "object"
        || Array.isArray(snapshot.dream)) {
        throw new TypeError("jungian dialogue snapshot is invalid");
      }
      elapsedSeconds = snapshot.elapsed_seconds;
      dream = { ...snapshot.dream };
    },
    snapshot() { return { dream: { ...dream }, elapsed_seconds: elapsedSeconds }; },
    spatial() {
      return {
        bounds: { max: [5, 2], min: [-5, -2] },
        objects: [
          { id: "object:analyst", position: [-2, 0], velocity: [0, 0] },
          { id: "object:daimon", position: [2, 0], velocity: [0, 0] },
        ],
      };
    },
    step(input) {
      elapsedSeconds += input.dt_seconds;
      return {
        action_results: input.actions.map((action) => ({
          accepted: false, code: "no_actions_in_dialogue", sequence: action.sequence,
        })),
        events: [],
        tick: input.tick,
      };
    },
  };
};

