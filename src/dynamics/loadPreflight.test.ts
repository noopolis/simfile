import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import type { Simfile } from "../schema/model.js";
import { parseSimfileSource } from "../schema/parse.js";
import { loadDynamicsSession } from "./load.js";
import {
  createDynamicsTestProject,
  removeDynamicsTestProject
} from "./testSupport.test-helper.js";

describe("loadDynamicsSession preflight", () => {
  it("rejects unsafe and symlinked authored paths before target evaluation", async () => {
    const project = await createDynamicsTestProject();
    try {
      for (const module of [
        "../target.mjs",
        "/tmp/target.mjs",
        "./systems/../target.mjs",
        "./systems/not portable.mjs",
        "./systems/target.js",
        `./systems/${"x".repeat(256)}.mjs`,
        "file:///tmp/target.mjs"
      ]) {
        await assert.rejects(loadDynamicsSession({
          ...project.simfile,
          dynamics: { config: {}, module }
        } as Simfile, { simfilePath: project.simfilePath }), /portable|path segments/u);
      }

      const marker = "__simfileLinkedProviderExecuted";
      delete (globalThis as Record<string, unknown>)[marker];
      const target = path.join(project.directory, "target.mjs");
      await writeFile(target, `globalThis[${JSON.stringify(marker)}] = true;\n`, "utf8");
      const leaf = path.join(project.directory, "systems", "linked.mjs");
      await symlink(target, leaf);
      await assert.rejects(loadDynamicsSession({
        ...project.simfile,
        dynamics: { module: "./systems/linked.mjs", config: {} }
      }, { simfilePath: project.simfilePath }), /symlink/u);

      const realDirectory = path.join(project.directory, "real-systems");
      await mkdir(realDirectory);
      await writeFile(path.join(realDirectory, "linked.mjs"), await readFile(target));
      await symlink(realDirectory, path.join(project.directory, "linked-systems"));
      await assert.rejects(loadDynamicsSession({
        ...project.simfile,
        dynamics: { module: "./linked-systems/linked.mjs", config: {} }
      }, { simfilePath: project.simfilePath }), /symlink/u);
      assert.equal((globalThis as Record<string, unknown>)[marker], undefined);
      delete (globalThis as Record<string, unknown>)[marker];
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("validates config, effective seed, and clock before preparing provider code", async () => {
    const project = await createDynamicsTestProject();
    try {
      for (const config of [(() => {
        const sparse: unknown[] = [];
        sparse[1] = 1;
        return { sparse };
      })(), JSON.parse('{"__proto__":{"polluted":true}}')]) {
        await assert.rejects(loadDynamicsSession({
          ...project.simfile,
          dynamics: { module: "./systems/tiny.mjs", config }
        } as Simfile, { simfilePath: project.simfilePath }), /sparse arrays|safe dynamics JSON key/u);
      }
      await assert.rejects(loadDynamicsSession(project.simfile, {
        seed: "x".repeat(257),
        simfilePath: project.simfilePath
      }), /seed exceeds/u);
      for (const seed of [null, 42, {}]) {
        await assert.rejects(loadDynamicsSession(project.simfile, {
          seed,
          simfilePath: project.simfilePath
        } as unknown as Parameters<typeof loadDynamicsSession>[1]), /seed must be/u);
      }
      for (const simPerTick of ["", null, false, 0, `1${"0".repeat(307)}w`]) {
        await assert.rejects(loadDynamicsSession({
          ...project.simfile,
          clock: { ...project.simfile.clock, sim_per_tick: simPerTick }
        } as unknown as Simfile, { simfilePath: project.simfilePath }), /duration|positive and finite/u);
      }
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("normalizes negative zero before config hashing and initialization", async () => {
    const source = `
export const createDynamicsProvider = () => {
  let state = { zero: 1 };
  return {
    api_version: "simfile.dynamics-provider.v1",
    id: "zero-normalizer",
    version: "1",
    state_schema_version: "v1",
    initialize(context) {
      state = { zero: typeof context.config.zero === "number" ? context.config.zero : 0 };
    },
    observe() { return { channels: [] }; },
    restore(snapshot) {
      if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
        throw new Error("invalid snapshot");
      }
      state = { zero: typeof snapshot.zero === "number" ? snapshot.zero : 0 };
    },
    snapshot() { return { ...state }; },
    step(input) { return { action_results: [], events: [], tick: input.tick }; }
  };
};
`;
    const project = await createDynamicsTestProject(
      source,
      "zero: -0"
    );
    try {
      const negative = await loadDynamicsSession(project.simfile, { simfilePath: project.simfilePath });
      const positive = parseSimfileSource(
        '{"simfile_version":"0.1","name":"zero","clock":{"seed":"load","tick":"20ms","sim_per_tick":"0.5s"},"dynamics":{"module":"./systems/tiny.mjs","config":{"zero":0}}}',
        { path: project.simfilePath }
      ).simfile;
      const right = await loadDynamicsSession(positive, { simfilePath: project.simfilePath });
      assert.ok(negative && right);
      assert.equal(negative.provenance.config_sha256, right.provenance.config_sha256);
      const state = negative.snapshot().provider_state as { zero: number };
      assert.equal(Object.is(state.zero, -0), false);
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("returns undefined without inspecting invalid options when dynamics is absent", async () => {
    const project = await createDynamicsTestProject();
    try {
      const { dynamics: _ignored, ...withoutDynamics } = project.simfile;
      withoutDynamics.clock.sim_per_tick = `1${"0".repeat(307)}w`;
      assert.equal(await loadDynamicsSession(withoutDynamics, {
        seed: "x".repeat(257),
        simfilePath: project.simfilePath
      }), undefined);
    } finally {
      await removeDynamicsTestProject(project);
    }
  });
});
