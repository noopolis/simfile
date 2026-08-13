import type { ReadonlyDynamicsJsonObject } from "../dynamics/types.js";
import type { LocalResourceReference } from "../world/addresses.js";
import {
  WORLD_SURFACE_API_VERSION,
  type WorldAffordanceContext,
  type WorldAffordanceLoweringInput,
  type WorldSenseProjectionInput
} from "./types.js";

type Callback = (input: unknown) => unknown;

export interface WorldSurfaceCallbackOverrides {
  readonly available?: Callback;
  readonly lower?: Callback;
  readonly project?: Callback;
  readonly projectResult?: Callback | null;
}

export const localRef = (value: string): LocalResourceReference =>
  value as LocalResourceReference;

export const publicObservation = () => ({
  channels: [{
    components: { x: 1 },
    sense_address: "sense:vision",
    subject_address: "entity:red",
    unit: "meters"
  }]
});

export const mechanicsObservation = (
  sense = "sense:state",
  subject = "object:internal-wall"
) => ({
  channels: [{
    components: { x: 2 },
    frame: "frame:world",
    sense_address: sense,
    subject_address: subject
  }]
});

export const worldContext = (): WorldAffordanceContext => ({
  holder: localRef("entity:red"),
  observation: publicObservation(),
  target: localRef("entity:ball")
});

export const worldLoweringInput = (
  input: ReadonlyDynamicsJsonObject = { force: 0.5 }
): WorldAffordanceLoweringInput => ({
  ...worldContext(),
  input
});

export const worldSenseInput = (): WorldSenseProjectionInput => ({
  holder: localRef("entity:red"),
  observation: mechanicsObservation()
});

export const validWorldSurface = (
  overrides: WorldSurfaceCallbackOverrides = {}
) => {
  const projectResult = overrides.projectResult === undefined
    ? ((result: unknown) => ({ outcome: (result as { accepted: boolean }).accepted }))
    : overrides.projectResult;
  return {
    affordances: {
      "affordance:kick": {
        available: overrides.available ?? (() => true),
        dynamics_action: "kick",
        input_schema: {
          additionalProperties: false,
          properties: {
            force: {
              maximum: 1,
              minimum: 0,
              type: "number"
            }
          },
          required: ["force"],
          type: "object"
        },
        lower: overrides.lower ?? ((input: unknown) => ({
          force: (input as { input: { force: number } }).input.force
        })),
        ...(projectResult === null ? {} : { project_result: projectResult }),
        rejection_codes: ["blocked"],
        target_selector: {
          kind: "fixed",
          targets: ["entity:ball"]
        }
      }
    },
    api_version: WORLD_SURFACE_API_VERSION,
    effects: {
      "effect:impact": {
        dynamics_event: "impact",
        payload_schema: {
          additionalProperties: false,
          properties: {
            strength: {
              maximum: 10,
              minimum: 0,
              type: "number"
            }
          },
          required: ["strength"],
          type: "object"
        }
      }
    },
    entities: {
      ball: {
        address: "entity:ball",
        dynamics_address: "object:ball"
      },
      red: {
        address: "entity:red",
        dynamics_address: "object:player.red"
      }
    },
    senses: {
      "sense:vision": {
        dynamics_senses: ["sense:state"],
        output: "simfile.numeric-observation.v1",
        project: overrides.project ?? (() => publicObservation())
      }
    }
  };
};
