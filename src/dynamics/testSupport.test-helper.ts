import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseSimfileSource } from "../schema/parse.js";
import type { Simfile } from "../schema/model.js";

// Test-only authored-provider/project helpers; excluded from production emit.

export const tinyProviderSource = (incrementScale = 1): string => `
export const createDynamicsProvider = () => {
  let state = { value: 0, last_dt_seconds: 0, last_tick: -1, sim_seconds_per_tick: 0 };
  return {
    api_version: "simfile.dynamics-provider.v1",
    dependencies: { "tiny-math": "1.0.0" },
    id: "tiny-counter",
    integration: { accepted_actions: ["increment"], model: "counter" },
    version: "1.0.0",
    state_schema_version: "counter.v1",
    initialize(context) {
      state = {
        value: context.config.start ?? 0,
        last_dt_seconds: 0,
        last_tick: -1,
        sim_seconds_per_tick: context.sim_seconds_per_tick
      };
    },
    observe(request) {
      return {
        channels: request.sense_addresses.includes("sense:counter") ? [{
          components: {
            last_dt_seconds: state.last_dt_seconds,
            last_tick: state.last_tick,
            sim_seconds_per_tick: state.sim_seconds_per_tick,
            value: state.value
          },
          sense_address: "sense:counter",
          subject_address: "object:counter",
          unit: "count"
        }] : []
      };
    },
    restore(snapshot) {
      state = structuredClone(snapshot);
    },
    snapshot() {
      return structuredClone(state);
    },
    step(input) {
      const action_results = [];
      const events = [];
      for (const command of input.actions) {
        if (
          command.action !== "increment"
          || command.target !== "object:counter"
          || typeof command.input.amount !== "number"
        ) {
          action_results.push({
            accepted: false,
            code: "unsupported_action",
            sequence: command.sequence
          });
          continue;
        }
        state.value += command.input.amount * ${incrementScale};
        action_results.push({ accepted: true, sequence: command.sequence });
        events.push({
          cause_action_sequences: [command.sequence],
          kind: "counter.changed",
          payload: { value: state.value },
          source: command.actor,
          target: command.target
        });
      }
      state.last_dt_seconds = input.dt_seconds;
      state.last_tick = input.tick;
      return { action_results, events, tick: input.tick };
    }
  };
};
`;

export interface DynamicsTestProject {
  directory: string;
  modulePath: string;
  simfile: Simfile;
  simfilePath: string;
}

export const createDynamicsTestProject = async (
  providerSource = tinyProviderSource(),
  configSource = "start: 2"
): Promise<DynamicsTestProject> => {
  const directory = await mkdtemp(path.join(tmpdir(), "simfile-dynamics-"));
  const systems = path.join(directory, "systems");
  await mkdir(systems);
  const modulePath = path.join(systems, "tiny.mjs");
  const simfilePath = path.join(directory, "Simfile");
  const simfileSource = `
simfile_version: "0.1"
name: dynamics-test
clock:
  seed: dynamics-seed
  tick: 20ms
  sim_per_tick: 0.5s
dynamics:
  module: ./systems/tiny.mjs
  config:
    ${configSource.replaceAll("\n", "\n    ")}
`;
  const looseProviderFactoryType =
    "/** @type {() => (Record<string, any> & { "
    + "initialize?: (context: {config: Record<string, any>, [key: string]: any}) => any, "
    + "observe?: (request: Record<string, any>) => any, restore?: (snapshot: any) => any, "
    + "snapshot?: () => any, "
    + "step?: (input: {actions: any[], tick: any, [key: string]: any}) => any "
    + "})} */";
  const typedProviderSource = providerSource.replace(
    "export const createDynamicsProvider =",
    `${looseProviderFactoryType}\nexport const createDynamicsProvider =`
  );
  await writeFile(modulePath, typedProviderSource, "utf8");
  await writeFile(simfilePath, simfileSource, "utf8");
  return {
    directory,
    modulePath,
    simfile: parseSimfileSource(simfileSource, { path: simfilePath }).simfile,
    simfilePath
  };
};

export const removeDynamicsTestProject = async (project: DynamicsTestProject): Promise<void> => {
  await rm(project.directory, { force: true, recursive: true });
};

export const counterObservationRequest = {
  observer: "agent:red",
  principal_id: "moltnet:red",
  sense_addresses: ["sense:counter"]
} as const;

export const counterAction = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  act_id: "act-1",
  action: "increment",
  actor: "agent:red",
  at_tick: 0,
  input: { amount: 3 },
  origin: "controller",
  principal_id: "moltnet:red",
  target: "object:counter",
  ...overrides
});
