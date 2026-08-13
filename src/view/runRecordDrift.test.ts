import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createDynamicsTestProject,
  removeDynamicsTestProject,
  tinyProviderSource
} from "../dynamics/testSupport.test-helper.js";
import { writeDynamicsRunRecord } from "../run/dynamics-run-record.js";
import { isObserveRunDir } from "./runDetect.js";
import { createViewerServer } from "./server.js";

/**
 * THE B192 DRIFT GUARD. `simfile run` produces a match and `simfile view`
 * renders one; before this they could not talk. Two independent failures had
 * to be fixed and either one alone leaves a blank page:
 *
 *  1. `isObserveRunDir()` required a moltnet transcript, so a local dynamics
 *     run fell through to the world/3D replay mode and died on
 *     "Replay artifact check failed — Missing artifacts: manifest.yaml,
 *     viewer-trace.json".
 *  2. Even in run-replay mode the trace carried ZERO spatial samples and ZERO
 *     agents, because per-tick body state was recorded nowhere on disk.
 *
 * So this test walks the whole path the browser walks — write a real run
 * record, start the real server, fetch the real endpoints — and asserts
 * MOVING content, not a 200. A server responding is not a match rendering.
 */

const MOVING_PROVIDER = tinyProviderSource().replace("    snapshot() {", `    spatial() {
      return {
        bounds: { max: [10, 6], min: [-10, -6] },
        objects: [
          { id: "object:counter", position: [state.last_tick, 0], velocity: [1, 0] },
          { id: "object:shadow", position: [0, state.last_tick], velocity: [0, 1] }
        ]
      };
    },
    snapshot() {`);

interface WorldPayload {
  trace: {
    agents: Array<{ id: string }>;
    rooms: Array<{ id: string }>;
    spatial_samples: Array<{
      objects?: Array<{ id: string; position: [number, number]; velocity: [number, number] }>;
      tick: number;
    }>;
    tick_duration_ms?: number;
  };
}

const record = async (providerSource: string, ticks: number): Promise<{
  cleanup: () => Promise<void>;
  outDir: string;
}> => {
  const project = await createDynamicsTestProject(providerSource);
  const outDir = path.join(project.directory, "run");
  await writeDynamicsRunRecord({

    outDir,
    runId: "drift-run",
    seed: "dynamics-seed",
    simfile: project.simfile,
    simfilePath: project.simfilePath,
    sourceText: await readFile(project.simfilePath, "utf8"),
    ticks,
    seams: { clock: () => new Date("2026-01-02T03:04:05.000Z") }
  });
  return { cleanup: () => removeDynamicsTestProject(project), outDir };
};

const served = async (
  outDir: string,
  body: (fetchPath: (route: string) => Promise<{ status: number; text: string }>) => Promise<void>
): Promise<void> => {
  const handle = await createViewerServer({ mode: "replay", port: 0, sourcePath: outDir });
  try {
    await body(async (route) => {
      const response = await fetch(`${handle.url}${route}`);
      return { status: response.status, text: await response.text() };
    });
  } finally {
    await handle.close();
  }
};

describe("simfile view renders a simfile run record", () => {
  it("selects run-replay for a transcript-free dynamics run record", async () => {
    // The exact condition that used to be false. A local dynamics run has no
    // moltnet and no reason to fabricate one.
    const { cleanup, outDir } = await record(MOVING_PROVIDER, 3);
    try {
      assert.equal(await isObserveRunDir(outDir), true);
      await assert.rejects(readFile(path.join(outDir, "raw/moltnet/transcript.json")));
      await served(outDir, async (fetchPath) => {
        const state = await fetchPath("/api/state");
        assert.equal(state.status, 200);
        assert.equal((JSON.parse(state.text) as { mode: string }).mode, "run-replay");
      });
    } finally {
      await cleanup();
    }
  });

  it("serves a world trace whose bodies actually move, with an agent for each", async () => {
    const ticks = 6;
    const { cleanup, outDir } = await record(MOVING_PROVIDER, ticks);
    try {
      await served(outDir, async (fetchPath) => {
        const world = await fetchPath("/api/world");
        assert.equal(world.status, 200);
        const { trace } = JSON.parse(world.text) as WorldPayload;

        // Ticks 0..N, one sample each — nothing dropped, nothing invented.
        assert.equal(trace.spatial_samples.length, ticks + 1);
        assert.deepEqual(trace.spatial_samples.map((sample) => sample.tick),
          [0, 1, 2, 3, 4, 5, 6]);

        // Every object has an agent node, or the client renders NOTHING:
        // spatial samples only override an existing node's position.
        const agentIds = new Set(trace.agents.map((agent) => agent.id));
        for (const sample of trace.spatial_samples) {
          assert.ok(sample.objects && sample.objects.length > 0);
          for (const object of sample.objects) assert.equal(agentIds.has(object.id), true);
        }

        // MOVING, not a frozen or synthetic track. This is the assertion that
        // distinguishes a rendered match from an empty pitch.
        const track = (id: string): string[] => trace.spatial_samples.map((sample) =>
          JSON.stringify(sample.objects?.find((object) => object.id === id)?.position));
        for (const id of ["object:counter", "object:shadow"]) {
          assert.equal(new Set(track(id)).size, ticks + 1, `${id} never moved`);
        }

        // The floor bodies move across, sized from the run's own bounds.
        assert.equal(trace.rooms.length, 1);
        // 0.5 simulated seconds per tick, carried from the frames header — the
        // client multiplies recorded per-second velocities by a duration
        // derived from this, so a wrong value misdraws every interpolation.
        assert.equal(trace.tick_duration_ms, 500);

        const timeline = await fetchPath("/api/timeline");
        assert.equal(timeline.status, 200);
        assert.ok(JSON.parse(timeline.text));

        // The world/3D replay error path is not taken anywhere.
        for (const payload of [world.text, timeline.text]) {
          for (const forbidden of [
            "artifact check failed", "Missing artifacts", "missing_artifacts",
            "no synthetic fallback trace"
          ]) assert.equal(payload.includes(forbidden), false);
        }
      });
    } finally {
      await cleanup();
    }
  });

  it("rejects a sealed run whose frame bytes drift after the manifest hash", async () => {
    // Prefix tolerance belongs only to the in-progress staging reader. Once a
    // manifest exists, its exact hash is the record and a torn replacement is
    // corruption rather than a live prefix.
    const { cleanup, outDir } = await record(MOVING_PROVIDER, 6);
    try {
      const framesPath = path.join(outDir, "raw", "frames.jsonl");
      const complete = await readFile(framesPath, "utf8");
      const lines = complete.split("\n").filter((line) => line.length > 0);
      const torn = `${lines.slice(0, 4).join("\n")}\n${lines[4]!.slice(0, 30)}`;
      const { writeFile, chmod } = await import("node:fs/promises");
      await chmod(framesPath, 0o644);
      await writeFile(framesPath, torn, "utf8");

      await assert.rejects(
        createViewerServer({ mode: "replay", port: 0, sourcePath: outDir }),
        /raw\/frames\.jsonl integrity failed/u,
      );
    } finally {
      await cleanup();
    }
  });

  it("still serves a run whose provider records no motion, without inventing any", async () => {
    const { cleanup, outDir } = await record(tinyProviderSource(), 2);
    try {
      assert.equal(await isObserveRunDir(outDir), true);
      await served(outDir, async (fetchPath) => {
        const state = await fetchPath("/api/state");
        assert.equal((JSON.parse(state.text) as { mode: string }).mode, "run-replay");
        const { trace } = JSON.parse((await fetchPath("/api/world")).text) as WorldPayload;
        assert.deepEqual(trace.spatial_samples, []);
        // No frames means no fabricated bodies and no frames-derived floor.
        assert.equal(trace.agents.some((agent) => agent.id.startsWith("object:")), false);
        assert.equal(trace.rooms.some((room) => room.id === "room:frames"), false);
      });
    } finally {
      await cleanup();
    }
  });
});
