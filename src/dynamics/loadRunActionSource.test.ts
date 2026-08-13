import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import type { Simfile } from "../schema/model.js";
import { loadDynamicsRunActionSource } from "./loadRunActionSource.js";
import {
  assertPathMissing,
  createLoadTestProject,
  providerFactorySource
} from "./load.test-helper.js";

const withGrants = (simfile: Simfile): Simfile => ({
  ...simfile,
  world: {
    id: "counter" as NonNullable<Simfile["world"]>["id"],
    grants: {
      blue: {
        entity: "entity:blue",
        senses: [],
        affordances: []
      }
    }
  } as unknown as NonNullable<Simfile["world"]>
});

const sourceExport = (body: string): string => `
/** @type {import("simfile/dynamics").DynamicsRunActionSourceFactory} */
export const createDynamicsRunActionSource = ${body};
`;

for (const extension of [".mjs", ".ts"] as const) {
  test(`loads a sealed ${extension} provider and action source together`, async (t) => {
    const project = await createLoadTestProject(t, {
      extension,
      source: providerFactorySource(extension) + sourceExport(`() => ({
  id: "sealed-script",
  live_acceptance: false,
  onTick() {},
  participants: ["blue"],
  provenance: "scripted",
  version: "simfile.dynamics-run-action-source.v1"
})`)
    });
    const loaded = await loadDynamicsRunActionSource(
      withGrants(project.simfile),
      project.options
    );
    assert.ok(loaded?.actionSource);
    assert.equal(loaded.actionSource.id, "sealed-script");
    assert.equal(
      loaded.session.provenance.module_sha256,
      loaded.session.buildReceipt.payload.artifact_sha256
    );
    const artifact = path.join(
      project.evidenceRoot,
      loaded.session.buildReceipt.payload.artifact_path
    );
    assert.equal((await readFile(artifact, "utf8")).includes("sealed-script"), true);
    await access(path.join(
      project.evidenceRoot,
      "dynamics",
      "build-receipt.json"
    ));
    await assertPathMissing(path.join(project.scratchRoot, "dynamics"));
  });
}

test("treats an absent export or synchronous undefined as no source", async (t) => {
  const absent = await createLoadTestProject(t, {
    source: providerFactorySource()
  });
  const omitted = await loadDynamicsRunActionSource(
    absent.simfile,
    absent.options
  );
  assert.ok(omitted);
  assert.equal(omitted.actionSource, undefined);

  const disabled = await createLoadTestProject(t, {
    source: providerFactorySource()
      + sourceExport("() => undefined")
  });
  const returned = await loadDynamicsRunActionSource(
    disabled.simfile,
    disabled.options
  );
  assert.ok(returned);
  assert.equal(returned.actionSource, undefined);
});

test("rejects an asynchronous factory and cleans scratch after preserving evidence", async (t) => {
  const project = await createLoadTestProject(t, {
    source: providerFactorySource()
      + `
/** @type {any} */
export const createDynamicsRunActionSource = async () => undefined;
`
  });
  await assert.rejects(
    loadDynamicsRunActionSource(project.simfile, project.options),
    /createDynamicsRunActionSource\(\) must be synchronous/u
  );
  await assertPathMissing(path.join(project.scratchRoot, "dynamics"));
  await access(path.join(
    project.evidenceRoot,
    "dynamics",
    "build-receipt.json"
  ));
});

test("validates the source before cleanup and passes deeply frozen canonical initialization", async (t) => {
  const project = await createLoadTestProject(t, {
    configSource: "nested:\n  values: [1, 2]",
    source: providerFactorySource() + sourceExport(`(initialization) => {
  const config = /** @type {any} */ (initialization.config);
  if (!Object.isFrozen(initialization)
    || !Object.isFrozen(config)
    || !Object.isFrozen(config.nested)
    || !Object.isFrozen(config.nested.values)
    || initialization.seed !== "load-seed"
    || initialization.sim_seconds_per_tick !== 0.5) {
    throw new Error("initialization was not canonical and frozen");
  }
  return {
    id: "frozen-source",
    live_acceptance: false,
    onTick() {},
    participants: ["blue"],
    provenance: "scripted",
    version: "simfile.dynamics-run-action-source.v1"
  };
}`)
  });
  const loaded = await loadDynamicsRunActionSource(
    withGrants(project.simfile),
    project.options
  );
  assert.equal(loaded?.actionSource?.id, "frozen-source");
  await assertPathMissing(path.join(project.scratchRoot, "dynamics"));
});

test("rejects source participants when world grants are absent", async (t) => {
  const project = await createLoadTestProject(t, {
    source: providerFactorySource() + sourceExport(`() => ({
  id: "undeclared",
  live_acceptance: false,
  onTick() {},
  participants: ["blue"],
  provenance: "scripted",
  version: "simfile.dynamics-run-action-source.v1"
})`)
  });
  await assert.rejects(
    loadDynamicsRunActionSource(project.simfile, project.options),
    /not declared in world\.grants/u
  );
  await assertPathMissing(path.join(project.scratchRoot, "dynamics"));
});
