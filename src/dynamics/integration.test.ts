import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadDynamicsSession } from "./load.js";
import {
  createDynamicsTestProject,
  removeDynamicsTestProject,
  tinyProviderSource
} from "./testSupport.test-helper.js";

describe("dynamics provider integration contract", () => {
  it("validates, deeply freezes, and exposes metadata through DynamicsSession", async () => {
    const project = await createDynamicsTestProject();
    try {
      const session = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath });
      assert.ok(session);
      const integration = session.integration;
      assert.deepEqual(integration, {
        accepted_actions: ["increment"],
        model: "counter"
      });
      assert.equal(Object.isFrozen(integration), true);
      assert.equal(Object.isFrozen(integration.accepted_actions), true);
      assert.throws(() => {
        (integration.accepted_actions as string[]).push("forge");
      }, TypeError);
      assert.deepEqual(session.integration, {
        accepted_actions: ["increment"],
        model: "counter"
      });
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("rejects unsafe metadata before provider initialization", async () => {
    const source = tinyProviderSource().replace(
      'integration: { accepted_actions: ["increment"], model: "counter" },',
      "integration: { unsafe: Infinity },"
    );
    const project = await createDynamicsTestProject(source);
    try {
      await assert.rejects(
        loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath }),
        /provider\.integration.*finite/u
      );
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("normalizes an omitted optional contract to an immutable empty object", async () => {
    const source = tinyProviderSource().replace(
      '    integration: { accepted_actions: ["increment"], model: "counter" },\n',
      ""
    );
    const project = await createDynamicsTestProject(source);
    try {
      const session = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath });
      assert.ok(session);
      assert.deepEqual(session.integration, {});
      assert.equal(Object.isFrozen(session.integration), true);
    } finally {
      await removeDynamicsTestProject(project);
    }
  });
});
