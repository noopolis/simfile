import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { get } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createDynamicsTestProject,
  removeDynamicsTestProject,
  tinyProviderSource,
} from "../dynamics/testSupport.test-helper.js";
import { writeDynamicsRunRecord } from "../run/dynamics-run-record.js";
import { findInProgressDynamicsRun } from "./runFollowLocator.js";
import { readRunFrames } from "./runFrames.js";
import { createViewerServer } from "./server.js";

const slowMovingProvider = tinyProviderSource().replace(
  "    snapshot() {",
  `    spatial() {
      return { bounds: { max: [10, 6], min: [-10, -6] }, objects: [
        { id: "object:counter", position: [state.last_tick, 0], velocity: [1, 0] }
      ] };
    },
    snapshot() {`,
).replace(
  "    step(input) {",
  "    step(input) { const started = Date.now(); while (Date.now() - started < 2) {}",
);

const startRun = async (ticks: number): Promise<{
  project: Awaited<ReturnType<typeof createDynamicsTestProject>>;
  outDir: string;
  stagingDir: string;
  run: Promise<unknown>;
}> => {
  const project = await createDynamicsTestProject(slowMovingProvider);
  const outDir = path.join(project.directory, "run");
  const sourceText = await readFile(project.simfilePath, "utf8");
  const run = writeDynamicsRunRecord({
    outDir, runId: "live-run", seed: "dynamics-seed", simfile: project.simfile,
    simfilePath: project.simfilePath, sourceText, ticks,
    seams: { clock: () => new Date("2026-01-02T03:04:05.000Z") },
  });
  let stagingDir: string | undefined;
  const deadline = Date.now() + 5_000;
  while (stagingDir === undefined && Date.now() < deadline) {
    stagingDir = await findInProgressDynamicsRun(outDir);
    if (stagingDir === undefined) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(stagingDir, "the real run must expose staging before its first flush");
  return { project, outDir, stagingDir, run };
};

const eventBodies = (text: string): Record<string, unknown>[] => text.split("\n")
  .filter((line) => line.startsWith("data: "))
  .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);

const createMonotonicSampleCounter = () => {
  let greatest = 0;
  return async (stagingDir: string, sealedDir: string): Promise<number> => {
    const staging = await readRunFrames(stagingDir);
    const sealed = staging === undefined ? await readRunFrames(sealedDir) : undefined;
    greatest = Math.max(greatest, staging?.samples.length ?? sealed?.samples.length ?? 0);
    return greatest;
  };
};

const waitForReadableSamples = async (
  stagingDir: string,
  sealedDir: string,
  countSamplesMonotonically: ReturnType<typeof createMonotonicSampleCounter>,
): Promise<number> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const samples = await countSamplesMonotonically(stagingDir, sealedDir);
    if (samples > 0) return samples;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return countSamplesMonotonically(stagingDir, sealedDir);
};

const completesWithin = async (promise: Promise<unknown>, timeoutMs: number): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

describe("live dynamics run viewer", () => {
  it("follows one real producer and matches the sealed sample sequence", async () => {
    const { project, outDir, stagingDir, run } = await startRun(80);
    const handle = await createViewerServer({ mode: "replay", port: 0, sourcePath: outDir });
    try {
      const response = await fetch(`${handle.url}/api/run-frames`);
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (!text.includes('"type":"sealed"')) {
        const next = await reader.read();
        if (next.done) break;
        text += decoder.decode(next.value, { stream: true });
      }
      await run;
      const sealed = await readRunFrames(outDir);
      const frames = eventBodies(text).filter((body) => body.type === "frame");
      assert.ok(frames.length > 50, "an empty capture must not pass vacuously");
      assert.ok(sealed);
      const sealedByTick = new Map(sealed.samples.map((sample) => [sample.tick, sample]));
      const ticks = frames.map((body) => (body.sample as { tick: number }).tick);
      assert.ok(ticks.every((tick, index) => index === 0 || tick > ticks[index - 1]),
        "live ticks must be strictly increasing");
      for (const body of frames) {
        const sample = body.sample as typeof sealed.samples[number];
        const recorded = sealedByTick.get(sample.tick);
        assert.ok(recorded, `live tick ${sample.tick} must exist in the sealed record`);
        assert.deepEqual(sample.objects, recorded.objects,
          `live geometry must match sealed tick ${sample.tick}`);
        assert.deepEqual(sample.occupancy, recorded.occupancy);
        assert.deepEqual(sample.transit, recorded.transit);
      }
      const skipped = eventBodies(text).reduce((total, body) =>
        total + (typeof body.skippedFrames === "number" ? body.skippedFrames : 0), 0);
      assert.equal(frames.length + skipped, sealed.samples.length,
        "delivered plus explicitly skipped frames must close against the record");
      assert.equal(ticks[0], sealed.samples[0].tick);
    } finally {
      await handle.close();
      await removeDynamicsTestProject(project);
    }
  });

  it("does not let a stalled SSE consumer stall the real run", async () => {
    const ticks = 1_200;
    const { project, outDir, run } = await startRun(ticks);
    const handle = await createViewerServer({ mode: "replay", port: 0, sourcePath: outDir });
    const response = await new Promise<{ resume: () => void }>((resolve, reject) => {
      const request = get(`${handle.url}/api/run-frames`, (incoming) => {
        incoming.pause();
        resolve({ resume: () => incoming.resume() });
      });
      request.on("error", reject);
    });
    try {
      const completed = await completesWithin(run, 30_000);
      assert.equal(completed, true,
        "a stalled SSE consumer must not prevent the producer from sealing");
      const sealed = await readRunFrames(outDir);
      assert.ok(sealed);
      assert.equal(sealed.samples.length, ticks + 1);
    } finally {
      response.resume();
      await handle.close();
      await removeDynamicsTestProject(project);
    }
  });

  it("keeps a draining consumer live while another consumer is stalled", async () => {
    const ticks = 1_200;
    const { project, outDir, run } = await startRun(ticks);
    const handle = await createViewerServer({ mode: "replay", port: 0, sourcePath: outDir });
    const stalled = await new Promise<{ resume: () => void }>((resolve, reject) => {
      const request = get(`${handle.url}/api/run-frames`, (incoming) => {
        incoming.pause();
        resolve({ resume: () => incoming.resume() });
      });
      request.on("error", reject);
    });
    try {
      const draining = await fetch(`${handle.url}/api/run-frames`);
      assert.equal(draining.status, 200);
      const reader = draining.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (!text.includes('"type":"sealed"')) {
        const next = await reader.read();
        if (next.done) break;
        text += decoder.decode(next.value, { stream: true });
      }
      await run;
      const sealed = await readRunFrames(outDir);
      assert.ok(sealed);
      const bodies = eventBodies(text);
      const frames = bodies.filter((body) => body.type === "frame");
      const skipped = bodies.reduce((total, body) =>
        total + (typeof body.skippedFrames === "number" ? body.skippedFrames : 0), 0);
      assert.ok(bodies.some((body) => body.type === "sealed"));
      assert.ok(frames.length > 10, "the draining consumer must receive live frames");
      assert.equal(frames.length + skipped, sealed.samples.length,
        "the draining stream must close against the sealed record despite the stalled peer");
    } finally {
      stalled.resume();
      await handle.close();
      await removeDynamicsTestProject(project);
    }
  });

  it("keeps the producer rate with no live consumer attached", async () => {
    const ticks = 80;
    const { project, stagingDir, run } = await startRun(ticks);
    try {
      const countSamplesMonotonically = createMonotonicSampleCounter();
      const before = await waitForReadableSamples(stagingDir, path.join(project.directory, "run"), countSamplesMonotonically);
      const started = Date.now();
      // The property is that the producer keeps advancing with nothing consuming
      // it — not that it hits a particular rate. Asserting ticks-per-second made
      // this fail on a contended 2-core CI runner (before=0, during=0) while
      // passing locally, which measured the hardware rather than the code.
      let during = before;
      const advanceDeadline = Date.now() + 30_000;
      while (during - before <= 10 && Date.now() < advanceDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        during = await countSamplesMonotonically(stagingDir, path.join(project.directory, "run"));
      }
      const elapsedSeconds = (Date.now() - started) / 1_000;
      await run;
      const sealed = await readRunFrames(path.join(project.directory, "run"));
      assert.ok(during - before > 10,
        `producer must advance without a consumer within 30s (before=${before}, during=${during})`);
      assert.ok(sealed);
      assert.equal(sealed.samples.length, ticks + 1);
      const noConsumerRate = (during - before) / elapsedSeconds;
      console.log(`no-consumer tick rate: ${noConsumerRate.toFixed(2)} ticks/s`);
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("atomically replaces pending metadata, identity, and timeline after seal", async () => {
    const { project, outDir, run } = await startRun(2);
    const handle = await createViewerServer({ mode: "replay", port: 0, sourcePath: outDir });
    try {
      assert.equal((await (await fetch(`${handle.url}/api/state`)).json() as { mode: string }).mode, "run-live");
      const meta = await (await fetch(`${handle.url}/api/run-meta`)).json() as Record<string, unknown>;
      assert.equal(meta.live, true);
      assert.deepEqual(meta.notYetComputed, ["runId", "verdict", "provenance", "engineProvenance"]);
      assert.equal("runId" in meta, false);
      assert.equal("verdict" in meta, false);
      assert.equal("provenance" in meta, false);
      assert.equal("engineProvenance" in meta, false);
      assert.equal((await fetch(`${handle.url}/api/timeline`)).status, 404);
      await run;
      const deadline = Date.now() + 3_000;
      let lifecycleResponse: Response | undefined;
      while (Date.now() < deadline) {
        lifecycleResponse = await fetch(`${handle.url}/api/run-lifecycle`);
        if (lifecycleResponse.ok) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(lifecycleResponse?.status, 200);
      const lifecycle = await lifecycleResponse!.json() as {
        mode: string;
        runMeta: Record<string, unknown>;
        timeline: { runId: string };
        world: { trace: { run_id: string } };
      };
      assert.equal(lifecycle.mode, "run-replay");
      assert.equal(lifecycle.runMeta.runId, "live-run");
      assert.equal(lifecycle.timeline.runId, "live-run");
      assert.equal(lifecycle.world.trace.run_id, "live-run");
      assert.equal("live" in lifecycle.runMeta, false);
      assert.equal("notYetComputed" in lifecycle.runMeta, false);
      assert.equal(typeof lifecycle.runMeta.verdict, "object");
      assert.equal(typeof lifecycle.runMeta.provenance, "object");
      assert.equal(typeof lifecycle.runMeta.engineProvenance, "object");
      assert.equal((await (await fetch(`${handle.url}/api/state`)).json() as { mode: string }).mode,
        "run-replay");
    } finally {
      await handle.close();
      await removeDynamicsTestProject(project);
    }
  });

  it("publishes exact seal identity without SSE and fails routes closed on mismatch", async () => {
    for (const mismatch of [false, true]) {
      const root = await mkdtemp(path.join(tmpdir(), "simfile-live-seal-server-"));
      const outDir = path.join(root, "run");
      const stagingDir = path.join(root, ".run.staging-test");
      const frames = Buffer.from([
        JSON.stringify({
          version: "simfile.dynamics-run-frames-header.v1",
          bounds: { min: [0, 0], max: [1, 1] },
          sim_seconds_per_tick: 1,
        }),
        JSON.stringify({
          version: "simfile.dynamics-run-frame.v1",
          tick: 0,
          objects: [],
        }),
        "",
      ].join("\n"));
      await mkdir(path.join(stagingDir, "raw"), { recursive: true });
      await writeFile(path.join(stagingDir, "raw", "frames.jsonl"), frames);
      const handle = await createViewerServer({
        extensionIdentities: [{ id: "fixture-renderer", status: "unsealed/local" }],
        reconcileViewerExtensionsAtSeal: async () => {
          if (mismatch) throw new Error("test identity mismatch");
          return [{ id: "fixture-renderer", status: "recorded" }];
        },
        mode: "replay",
        port: 0,
        sourcePath: outDir,
      });
      try {
        await mkdir(path.join(outDir, "raw"), { recursive: true });
        await writeFile(path.join(outDir, "raw", "frames.jsonl"), frames);
        await writeFile(path.join(outDir, "manifest.json"), JSON.stringify({
          version: "simfile.run-manifest.v1",
          run_id: "live-seal-test",
          created_at: "2026-08-05T00:00:00.000Z",
          contract_versions: {},
          artifacts: [{
            path: "raw/frames.jsonl",
            sha256: createHash("sha256").update(frames).digest("hex"),
          }],
        }));
        const deadline = Date.now() + 2_000;
        let response: Response | undefined;
        while (Date.now() < deadline) {
          response = mismatch
            ? await fetch(`${handle.url}/_simfile/viewer-extensions/fixture-renderer/module.js`)
            : await fetch(`${handle.url}/api/world`);
          if (mismatch && response.status === 409) break;
          if (!mismatch && response.ok
            && (await response.clone().json() as { trace: {
              viewer_extensions?: Array<{ status: string }>;
            } }).trace.viewer_extensions?.[0]?.status === "recorded") break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.ok(response);
        if (mismatch) {
          assert.equal(response.status, 409);
          assert.match(await response.text(), /failed closed/u);
        } else {
          assert.equal(response.status, 200);
          const world = await response.json() as { trace: {
            viewer_extensions: Array<{ status: string }>;
          } };
          assert.equal(world.trace.viewer_extensions[0]?.status, "recorded");
        }
      } finally {
        await handle.close();
        await rm(root, { force: true, recursive: true });
      }
    }
  });
});
