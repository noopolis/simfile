export const createWorldSurfaceDefinition = () => ({
  affordances: {},
  api_version: "simfile.world-surface.v1",
  effects: {},
  entities: {
    counter: {
      address: "entity:counter",
      dynamics_address: "object:counter",
    },
  },
  senses: {
    "sense:value": {
      dynamics_senses: ["sense:value"],
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
