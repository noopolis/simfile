import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadDynamicsSession } from "./load.js";
import {
  createDynamicsTestProject,
  removeDynamicsTestProject,
  tinyProviderSource
} from "./testSupport.test-helper.js";

/**
 * The session half of the optional `spatial()` seam. `spatial()` is a THIRD
 * projection of provider state, alongside `snapshot()` (whose round-trip the
 * session verifies) and `observe()` (which is grant-gated), so the host checks
 * everything it can: the call may not mutate, may not be async, and its output
 * must parse. A provider that omits it stays valid and simply records nothing.
 */
const withSpatial = (body: string): string => tinyProviderSource().replace(
  "    snapshot() {",
  `    spatial() {\n${body}\n    },\n    snapshot() {`
);

const session = async (providerSource: string) => {
  const project = await createDynamicsTestProject(providerSource);
  const loaded = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath });
  assert.ok(loaded);
  return { loaded, project };
};

describe("DynamicsSession.spatial", () => {
  it("returns undefined for a provider that declares no projection", async () => {
    const { loaded, project } = await session(tinyProviderSource());
    try {
      assert.equal(loaded.spatial(), undefined);
      // Degrading must not close the session or disturb the tick counter.
      loaded.step();
      assert.equal(loaded.nextTick, 1);
      assert.equal(loaded.spatial(), undefined);
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("projects the provider's current state and tracks it across steps", async () => {
    const { loaded, project } = await session(withSpatial(
      `      return { bounds: { max: [8, 8], min: [-8, -8] },
        objects: [{ id: "object:counter", position: [state.value, state.last_tick],
          velocity: [1, 0] }] };`
    ));
    try {
      assert.deepEqual(loaded.spatial(), {
        bounds: { max: [8, 8], min: [-8, -8] },
        objects: [{ id: "object:counter", position: [2, -1], velocity: [1, 0] }]
      });
      loaded.step();
      assert.deepEqual(loaded.spatial()?.objects[0]?.position, [2, 0]);
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("rejects a projection that mutates state, and rolls the provider back", async () => {
    const { loaded, project } = await session(withSpatial(
      `      state.value += 1;
      return { objects: [{ id: "object:counter", position: [state.value, 0], velocity: [0, 0] }] };`
    ));
    try {
      assert.throws(() => loaded.spatial(), /spatial\(\) must not mutate state/u);
      // Rolled back: the mutation the projection attempted is not observable.
      assert.equal(loaded.observe({
        observer: "agent:red",
        principal_id: "moltnet:red",
        sense_addresses: ["sense:counter"]
      }).channels[0]?.components.value, 2);
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("rejects an invalid projection rather than recording it", async () => {
    const { loaded, project } = await session(withSpatial(
      `      return { objects: [{ id: "object:counter", position: [NaN, 0], velocity: [0, 0] }] };`
    ));
    try {
      assert.throws(() => loaded.spatial(), /must be a finite number/u);
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("rejects an asynchronous projection at load, before any tick runs", async () => {
    const project = await createDynamicsTestProject(
      tinyProviderSource().replace("    snapshot() {",
        "    async spatial() { return { objects: [] }; },\n    snapshot() {")
    );
    try {
      await assert.rejects(
        loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath }),
        /spatial\(\) must be synchronous/u
      );
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("rejects a non-function spatial at load", async () => {
    const project = await createDynamicsTestProject(
      tinyProviderSource().replace("    snapshot() {", "    spatial: 7,\n    snapshot() {")
    );
    try {
      await assert.rejects(
        loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath }),
        /spatial\(\) must be a function/u
      );
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("agrees with a projection taken from restore(snapshot()) — the seam's honesty check", async () => {
    // Without this, `spatial()` could animate a match that never happened
    // while every artifact hash still verified: nothing else forces the
    // projection to agree with the state the record actually seals.
    const { loaded, project } = await session(withSpatial(
      `      return { objects: [{ id: "object:counter",
        position: [state.value, state.last_tick], velocity: [0, 0] }] };`
    ));
    try {
      loaded.step();
      loaded.step();
      const live = loaded.spatial();
      const snapshot = loaded.snapshot();
      loaded.restore(JSON.parse(JSON.stringify(snapshot)) as unknown);
      assert.deepEqual(loaded.spatial(), live);
    } finally {
      await removeDynamicsTestProject(project);
    }
  });
});
