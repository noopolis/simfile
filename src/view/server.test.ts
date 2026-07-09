import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { createViewerServer } from "./server.js";

describe("createViewerServer", () => {
  it("serves live state and skin metadata", async () => {
    const statePath = await mkdtemp(path.join(tmpdir(), "simfile-view-state-"));
    const handle = await createViewerServer({
      mode: "live",
      port: 0,
      sourcePath: ".",
      statePath,
    });

    try {
      const stateResponse = await fetch(`${handle.url}/api/state`);
      assert.equal(stateResponse.status, 200);
      const state = await stateResponse.json() as Record<string, unknown>;
      assert.equal(state.mode, "live");
      assert.equal(state.statePath, statePath);

      const skinsResponse = await fetch(`${handle.url}/api/skins`);
      assert.equal(skinsResponse.status, 200);
      const skins = await skinsResponse.json() as { options: unknown[] };
      assert.ok(skins.options.length >= 1);
    } finally {
      await handle.close();
    }
  });

  it("serves the viewer shell", async () => {
    const handle = await createViewerServer({
      mode: "replay",
      port: 0,
      sourcePath: "runs/latest",
    });

    try {
      const response = await fetch(`${handle.url}/`);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Simfile View/);
    } finally {
      await handle.close();
    }
  });

  it("serves viewer traces from replay run directories", async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), "simfile-view-run-"));
    await writeFile(path.join(runDir, "manifest.yaml"), "run_id: run-api\n", "utf8");
    await writeFile(path.join(runDir, "viewer-trace.json"), JSON.stringify({
      agents: [],
      corridors: [],
      ledger_facts: [],
      presence: [],
      rooms: [],
      run_id: "run-api",
      run_name: "api-world",
      signals: [],
      version: "viewer.trace.v1"
    }), "utf8");
    const handle = await createViewerServer({
      mode: "replay",
      port: 0,
      sourcePath: runDir,
    });

    try {
      const response = await fetch(`${handle.url}/api/world`);
      assert.equal(response.status, 200);
      const body = await response.json() as { run_id: string; trace: { version: string } };
      assert.equal(body.run_id, "run-api");
      assert.equal(body.trace.version, "viewer.trace.v1");
    } finally {
      await handle.close();
    }
  });

  it("fails replay mode when required artifacts are missing", async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), "simfile-view-run-missing-"));
    await writeFile(path.join(runDir, "viewer-trace.json"), JSON.stringify({
      agents: [],
      corridors: [],
      ledger_facts: [],
      presence: [],
      rooms: [],
      run_id: "run-missing",
      run_name: "missing-artifacts",
      signals: [],
      version: "viewer.trace.v1"
    }), "utf8");
    const handle = await createViewerServer({
      mode: "replay",
      port: 0,
      sourcePath: runDir,
    });

    try {
      const response = await fetch(`${handle.url}/api/world`);
      assert.equal(response.status, 404);
      const body = await response.json() as { error: string; mode: string; missing_artifacts: string[] };
      assert.equal(body.mode, "replay");
      assert.equal(typeof body.error, "string");
      assert.ok(body.missing_artifacts.includes("manifest.yaml"));
    } finally {
      await handle.close();
    }
  });

  it("serves viewer traces from the shipped office fixture run", async () => {
    const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "runs", "office-world-v0");
    const handle = await createViewerServer({
      mode: "replay",
      port: 0,
      sourcePath: fixturePath,
    });

    try {
      const response = await fetch(`${handle.url}/api/world`);
      assert.equal(response.status, 200);
      const body = await response.json() as { run_id: string; run_name: string; trace: { version: string } };
      assert.equal(body.run_name, "office-world-v0");
      assert.equal(body.trace.version, "viewer.trace.v1");
    } finally {
      await handle.close();
    }
  });

  it("returns an explicit missing-trace error instead of fallback world data", async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), "simfile-view-missing-run-"));
    const handle = await createViewerServer({
      mode: "replay",
      port: 0,
      sourcePath: runDir,
    });

    try {
      const response = await fetch(`${handle.url}/api/world`);
      assert.equal(response.status, 404);
      const body = await response.json() as {
        error: string;
        mode?: "live" | "replay";
        missing_artifacts?: string[];
      };
      assert.equal(typeof body.error, "string");
      assert.ok(body.error.includes("sealed replay directory"));
      assert.deepStrictEqual(body.missing_artifacts?.sort(), ["manifest.yaml", "viewer-trace.json"].sort());
    } finally {
      await handle.close();
    }
  });
});
