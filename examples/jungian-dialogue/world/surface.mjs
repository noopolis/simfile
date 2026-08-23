export const createWorldSurfaceDefinition = () => ({
  affordances: {},
  api_version: "simfile.world-surface.v1",
  effects: {},
  entities: {
    analyst: { address: "entity:analyst", dynamics_address: "object:analyst" },
    daimon: { address: "entity:daimon", dynamics_address: "object:daimon" },
  },
  senses: {
    "sense:dream": {
      dynamics_senses: ["sense:dream"],
      output: "simfile.numeric-observation.v1",
      project(input) {
        return {
          channels: input.observation.channels.map((channel) => ({
            ...channel,
            subject_address: input.holder,
          })),
        };
      },
    },
  },
});

