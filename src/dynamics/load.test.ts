import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { loadDynamicsSession } from "./load.js";
import {
  assertPathMissing,
  createLoadTestProject,
  providerFactorySource
} from "./load.test-helper.js";

const evidencePaths = (
  evidenceRoot: string,
  artifactSha256: string
): { artifact: string; receipt: string } => ({
  artifact: path.join(
    evidenceRoot,
    "dynamics",
    `sha256-${artifactSha256}`,
    "provider.mjs"
  ),
  receipt: path.join(evidenceRoot, "dynamics", "build-receipt.json")
});

describe("loadDynamicsSession sealed artifact path", () => {
  for (const extension of [".mjs", ".ts"] as const) {
    it(`loads a sealed ${extension} provider and records artifact identity separately`, async (t) => {
      const project = await createLoadTestProject(t, {
        extension,
        source: providerFactorySource(extension)
      });
      const authoredBytes = await readFile(project.modulePath);
      const session = await loadDynamicsSession(project.simfile, project.options);
      assert.ok(session);
      assert.deepEqual(session.provenance, {
        api_version: "simfile.dynamics-provider.v1",
        config_sha256: createHash("sha256").update('{"start":2}').digest("hex"),
        module: `./systems/provider${extension}`,
        module_sha256: session.buildReceipt.payload.artifact_sha256,
        node_version: process.version,
        numeric_model: "ieee754-binary64",
        provider_dependencies: { "tiny-math": "1.0.0" },
        provider_id: "sealed-counter",
        provider_version: "1.0.0",
        state_schema_version: "counter.v1"
      });
      assert.notEqual(
        session.provenance.module_sha256,
        createHash("sha256").update(authoredBytes).digest("hex")
      );
      assert.equal(Object.isFrozen(session.buildReceipt), true);
      assert.equal(Object.isFrozen(session.buildReceipt.payload), true);
      assert.equal("buildReceipt" in session.provenance, false);
      assert.equal("buildReceipt" in session.snapshot(), false);
      assert.equal(JSON.stringify(session.buildReceipt).includes(project.directory), false);

      const evidence = evidencePaths(
        project.evidenceRoot,
        session.provenance.module_sha256
      );
      assert.equal(
        createHash("sha256").update(await readFile(evidence.artifact)).digest("hex"),
        session.buildReceipt.payload.artifact_sha256
      );
      assert.deepEqual(
        [...await readFile(evidence.receipt)],
        session.buildReceipt.receiptBytes
      );
      await assertPathMissing(path.join(project.scratchRoot, "dynamics"));
    });
  }

  it("hashes canonical config and changes artifact identity with authored source", async (t) => {
    const project = await createLoadTestProject(t, {
      source: providerFactorySource(".mjs")
    });
    const firstConfig = {
      ...project.simfile,
      dynamics: { module: "./systems/provider.mjs", config: { b: 2, a: 1 } }
    };
    const secondConfig = {
      ...project.simfile,
      dynamics: { module: "./systems/provider.mjs", config: { a: 1, b: 2 } }
    };
    const automatic = { simfilePath: project.simfilePath };
    const first = await loadDynamicsSession(firstConfig, automatic);
    const second = await loadDynamicsSession(secondConfig, automatic);
    assert.ok(first && second);
    assert.equal(first.provenance.config_sha256, second.provenance.config_sha256);
    assert.equal(first.provenance.module_sha256, second.provenance.module_sha256);

    await writeFile(
      project.modulePath,
      providerFactorySource(".mjs", "const sourceRevision = 2; void sourceRevision;"),
      "utf8"
    );
    const reloaded = await loadDynamicsSession(project.simfile, automatic);
    assert.ok(reloaded);
    assert.notEqual(reloaded.provenance.module_sha256, first.provenance.module_sha256);
  });

  it("re-evaluates the whole bundled graph for every session", async (t) => {
    const project = await createLoadTestProject(t, {
      source: [
        'import { nextCall } from "./dependency.mjs";',
        '/** @type {import("simfile/dynamics").DynamicsProviderModule["createDynamicsProvider"]} */',
        "export const createDynamicsProvider = () => {",
        "  const factoryCall = nextCall();",
        "  let state = { factory_call: factoryCall };",
        "  return {",
        '    api_version: "simfile.dynamics-provider.v1", id: "graph-probe",',
        '    version: "1", state_schema_version: "v1",',
        "    initialize() {}, observe() { return { channels: [] }; },",
        "    restore(snapshot) {",
        '      if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) throw new Error("bad");',
        '      state = { factory_call: typeof snapshot.factory_call === "number" ? snapshot.factory_call : 0 };',
        "    },",
        "    snapshot() { return { ...state }; },",
        "    step(input) { return { action_results: [], events: [], tick: input.tick }; }",
        "  };",
        "};"
      ].join("\n")
    });
    await writeFile(
      path.join(project.directory, "systems", "dependency.mjs"),
      "let calls = 0;\nexport const nextCall = () => { calls += 1; return calls; };\n",
      "utf8"
    );
    const automatic = { simfilePath: project.simfilePath };
    const first = await loadDynamicsSession(project.simfile, automatic);
    const second = await loadDynamicsSession(project.simfile, automatic);
    assert.ok(first && second);
    assert.deepEqual(first.snapshot().provider_state, { factory_call: 1 });
    assert.deepEqual(second.snapshot().provider_state, { factory_call: 1 });
    assert.deepEqual(first.provenance, second.provenance);
  });

  it("rejects missing, invalid, and asynchronous named factories after preserving evidence", async (t) => {
    for (const [source, message] of [
      ["export default () => ({});\n", /named createDynamicsProvider/u],
      ["export const createDynamicsProvider = 3;\n", /named createDynamicsProvider/u],
      ["export const createDynamicsProvider = () => null;\n", /must return an object/u],
      ["export const createDynamicsProvider = async () => ({});\n", /must be synchronous/u]
    ] as const) {
      const project = await createLoadTestProject(t, { source });
      await assert.rejects(
        loadDynamicsSession(project.simfile, project.options),
        message
      );
      await assertPathMissing(path.join(project.scratchRoot, "dynamics"));
      await access(path.join(project.evidenceRoot, "dynamics", "build-receipt.json"));
    }
  });

  it("rejects invalid provider output and cleans caller scratch", async (t) => {
    const project = await createLoadTestProject(t, {
      source: [
        '/** @type {import("simfile/dynamics").DynamicsProviderModule["createDynamicsProvider"]} */',
        "export const createDynamicsProvider = () => ({",
        '  api_version: "simfile.dynamics-provider.v1",',
        '  id: "bad-snapshot", version: "1", state_schema_version: "v1",',
        "  initialize() {}, observe() { return { channels: [] }; }, restore() {},",
        "  snapshot() { return /** @type {any} */ (new Date(0)); },",
        "  step(input) { return { action_results: [], events: [], tick: input.tick }; }",
        "});"
      ].join("\n")
    });
    await assert.rejects(
      loadDynamicsSession(project.simfile, project.options),
      /JSON-compatible|plain JSON objects/u
    );
    await assertPathMissing(path.join(project.scratchRoot, "dynamics"));
  });

  it("detects final source drift before invoking the factory", async (t) => {
    const hookKey = "__simfileLoadMutateAuthoredSource";
    const project = await createLoadTestProject(t, {
      source: [
        `const mutateSource = /** @type {any} */ (globalThis)[${JSON.stringify(hookKey)}];`,
        'if (typeof mutateSource !== "function") throw new Error("MUTATION_HOOK_MISSING");',
        "mutateSource();",
        providerFactorySource(".mjs", 'throw new Error("FACTORY_RAN");')
      ].join("\n")
    });
    (globalThis as Record<string, unknown>)[hookKey] = () =>
      writeFileSync(project.modulePath, "export const drifted = true;\n", "utf8");
    t.after(() => { delete (globalThis as Record<string, unknown>)[hookKey]; });
    await assert.rejects(
      loadDynamicsSession(project.simfile, project.options),
      /prepared project descriptor mismatch/u
    );
    await assertPathMissing(path.join(project.scratchRoot, "dynamics"));
    await access(path.join(project.evidenceRoot, "dynamics", "build-receipt.json"));
  });
});
