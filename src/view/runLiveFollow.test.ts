import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { readLiveWorld } from "./runLiveFollow.js";
import { createViewerServer } from "./server.js";

describe("read-only live run follow", () => {
  it("reads the open frame prefix without changing producer bytes", async () => {
    const staging = await mkdtemp(path.join(tmpdir(), "simfile-live-follow-"));
    const raw = path.join(staging, "raw");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(raw));
    const framesPath = path.join(raw, "frames.jsonl");
    const bytes = [
      JSON.stringify({ version: "simfile.run-frames.v1", bounds: {
        min_x: 0, min_y: 0, max_x: 10, max_y: 10,
      }, sim_seconds_per_tick: 0.02 }),
      JSON.stringify({ tick: 0, objects: [] }),
      "",
    ].join("\n");
    await writeFile(framesPath, bytes, "utf8");
    const before = await stat(framesPath);
    const world = await readLiveWorld(staging);
    const after = await stat(framesPath);
    assert.equal(world.version, "viewer.trace.v1");
    assert.equal(await readFile(framesPath, "utf8"), bytes);
    assert.equal(after.size, before.size);
    assert.equal(after.ino, before.ino);
  });

  it("the follower source has no producer or mechanics mutation capability", async () => {
    const source = await readFile(new URL("./runLiveFollow.ts", import.meta.url), "utf8");
    for (const forbidden of [
      "writeFile", "appendFile", "rename(", "unlink(", "executeComposedRun",
      "stepDynamics", "world_act", "activateTopology", "stopWorld",
    ]) assert.equal(source.includes(forbidden), false, forbidden);
  });

  it("emits final manifest-bound extension data before the sealed event", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-live-follow-seal-"));
    const outDir = path.join(root, "run");
    const stagingDir = path.join(root, ".run.staging-terminal");
    const frames = Buffer.from([
      JSON.stringify({
        bounds: { max: [1, 1], min: [0, 0] },
        sim_seconds_per_tick: 1,
        version: "simfile.dynamics-run-frames-header.v1",
      }),
      JSON.stringify({ objects: [], tick: 0,
        version: "simfile.dynamics-run-frame.v1" }),
      "",
    ].join("\n"));
    const terminal = Buffer.from(`${JSON.stringify({
      playback_status: "completed", spatial_samples: [{ objects: [], tick: 0 }],
    })}\n`);
    const digest = (value: Uint8Array): string =>
      createHash("sha256").update(value).digest("hex");
    await mkdir(path.join(stagingDir, "raw"), { recursive: true });
    await writeFile(path.join(stagingDir, "raw", "frames.jsonl"), frames);
    const handle = await createViewerServer({
      extensionIdentities: [{ id: "fixture-renderer", status: "unsealed/local" }],
      mode: "replay", port: 0,
      reconcileViewerExtensionsAtSeal: async () =>
        [{ id: "fixture-renderer", status: "recorded" }],
      sourcePath: outDir,
    });
    const abort = new AbortController();
    try {
      const response = await fetch(`${handle.url}/api/run-frames`, { signal: abort.signal });
      assert.equal(response.status, 200);
      const streamed = response.text();
      await mkdir(path.join(stagingDir, "presentation"), { recursive: true });
      await writeFile(path.join(stagingDir, "presentation", "final.json"), terminal);
      await writeFile(path.join(stagingDir, "manifest.json"), JSON.stringify({
        artifacts: [
          { path: "raw/frames.jsonl", sha256: digest(frames) },
          { path: "presentation/final.json", sha256: digest(terminal) },
        ],
        contract_versions: {}, created_at: "2026-08-09T00:00:00.000Z",
        run_id: "terminal-extension", version: "simfile.run-manifest.v1",
        world: { viewer_extension_data: {
          "fixture-renderer": "presentation/final.json",
        } },
      }));
      await rename(stagingDir, outDir);
      const timeout = setTimeout(() => abort.abort(), 3_000);
      const text = await streamed.finally(() => clearTimeout(timeout));
      const bodies = text.split("\n").filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
      const extensionIndex = bodies.findIndex((body) => body.type === "viewer-extension-data");
      const sealedIndex = bodies.findIndex((body) => body.type === "sealed");
      assert.ok(extensionIndex >= 0);
      assert.equal(sealedIndex, extensionIndex + 1);
      assert.deepEqual((bodies[extensionIndex]?.extensionData as Record<string, unknown>)
        ["fixture-renderer"], JSON.parse(terminal.toString("utf8")));
      assert.deepEqual(bodies[sealedIndex]?.viewerExtensions,
        [{ id: "fixture-renderer", status: "recorded" }]);
    } finally {
      abort.abort();
      await handle.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("contains malformed live extension data inside the observer stream", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-live-follow-invalid-"));
    const outDir = path.join(root, "run");
    const stagingDir = path.join(root, ".run.staging-invalid");
    await mkdir(path.join(stagingDir, "raw"), { recursive: true });
    await writeFile(path.join(stagingDir, "raw", "frames.jsonl"), [
      JSON.stringify({ bounds: { max: [1, 1], min: [0, 0] },
        sim_seconds_per_tick: 1,
        version: "simfile.dynamics-run-frames-header.v1" }),
      JSON.stringify({ objects: [], tick: 0,
        version: "simfile.dynamics-run-frame.v1" }),
      "",
    ].join("\n"));
    const handle = await createViewerServer({ mode: "replay", port: 0,
      sourcePath: outDir });
    const abort = new AbortController();
    try {
      const response = await fetch(`${handle.url}/api/run-frames`, { signal: abort.signal });
      const streamed = response.text();
      await writeFile(path.join(stagingDir, "viewer-extension-data.json"), "{malformed");
      const timeout = setTimeout(() => abort.abort(), 3_000);
      const text = await streamed.finally(() => clearTimeout(timeout));
      const bodies = text.split("\n").filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
      assert.equal(bodies.at(-1)?.type, "viewer-extension-mismatch");
      assert.equal(bodies.some(({ type }) => type === "sealed"), false);
    } finally {
      abort.abort();
      await handle.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
