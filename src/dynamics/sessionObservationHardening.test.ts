import assert from "node:assert/strict";
import test from "node:test";

import { DYNAMICS_LIMITS } from "./limits.js";
import { loadDynamicsSession } from "./load.js";
import {
  counterObservationRequest,
  createDynamicsTestProject,
  removeDynamicsTestProject
} from "./testSupport.test-helper.js";

test("enforces observation channel and component fuses", async () => {
  for (const [source, expected] of [[`
export const createDynamicsProvider = () => {
  let state = { value: 0 };
  return {
    api_version: "simfile.dynamics-provider.v1", id: "channel-fuse", version: "1", state_schema_version: "v1",
    initialize() {}, restore(value) { state = structuredClone(value); }, snapshot() { return structuredClone(state); },
    observe() { return { channels: Array.from({ length: ${DYNAMICS_LIMITS.observation_channels + 1} }, (_, index) => ({
      components: { value: index }, sense_address: "sense:counter", subject_address: "object:o" + index
    })) }; },
    step(input) { return { action_results: [], events: [], tick: input.tick }; }
  };
};
`, /channel limit/u], [`
export const createDynamicsProvider = () => {
  let state = { value: 0 };
  return {
    api_version: "simfile.dynamics-provider.v1", id: "component-fuse", version: "1", state_schema_version: "v1",
    initialize() {}, restore(value) { state = structuredClone(value); }, snapshot() { return structuredClone(state); },
    observe() { return { channels: [{
      components: Object.fromEntries(Array.from({ length: ${DYNAMICS_LIMITS.observation_components_per_channel + 1} }, (_, index) => ["v" + index, index])),
      sense_address: "sense:counter", subject_address: "object:test"
    }] }; },
    step(input) { return { action_results: [], events: [], tick: input.tick }; }
  };
};
`, /component limit/u]] as const) {
    const project = await createDynamicsTestProject(source);
    try {
      const session = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath });
      assert.ok(session);
      const before = session.snapshot();
      assert.throws(() => session.observe(counterObservationRequest), expected);
      assert.deepEqual(session.snapshot(), before);
    } finally {
      await removeDynamicsTestProject(project);
    }
  }
});
