import assert from "node:assert/strict";
import test from "node:test";

import { loadDynamicsSession } from "./load.js";
import {
  counterAction,
  createDynamicsTestProject,
  removeDynamicsTestProject,
} from "./testSupport.test-helper.js";

const providerSource = (unknownSequence = false): string => `
export const createDynamicsProvider = () => {
  let state = { declared: 0, last_tick: -1 };
  return {
    api_version: "simfile.dynamics-provider.v1",
    id: "commitment-probe",
    version: "1",
    state_schema_version: "v1",
    initialize() {},
    observe() { return { channels: [] }; },
    restore(value) { state = structuredClone(value); },
    snapshot() { return structuredClone(state); },
    step(input) {
      const action_results = input.actions.map(({ sequence }) => {
        state.declared = sequence;
        return { accepted: true, sequence };
      });
      const commitment_outcomes = input.tick === 1 ? [{
        commitment_id: "commitment:alpha:1",
        declaration_action_sequence: ${unknownSequence ? "999" : "state.declared"},
        outcome: "fulfilled",
        participant: "object:participant.alpha"
      }] : [];
      state.last_tick = input.tick;
      return { action_results, commitment_outcomes, events: [], tick: input.tick };
    }
  };
};
`;

test("stamps a prior accepted declaration outcome at its terminal tick", async () => {
  const project = await createDynamicsTestProject(providerSource());
  try {
    const session = await loadDynamicsSession(project.simfile, {
      simfilePath: project.simfilePath,
    });
    assert.ok(session);
    session.queueAction(counterAction());
    assert.deepEqual(session.step().commitment_outcomes, []);
    assert.deepEqual(session.step().commitment_outcomes, [{
      commitment_id: "commitment:alpha:1",
      declaration_action_sequence: 1,
      outcome: "fulfilled",
      participant: "object:participant.alpha",
      provenance: "mechanical",
      tick: 1,
    }]);
  } finally {
    await removeDynamicsTestProject(project);
  }
});

test("rejects an outcome without an accepted declaration sequence", async () => {
  const project = await createDynamicsTestProject(providerSource(true));
  try {
    const session = await loadDynamicsSession(project.simfile, {
      simfilePath: project.simfilePath,
    });
    assert.ok(session);
    session.queueAction(counterAction());
    session.step();
    assert.throws(
      () => session.step(),
      /commitment outcome references rejected action sequence 999/u,
    );
  } finally {
    await removeDynamicsTestProject(project);
  }
});
