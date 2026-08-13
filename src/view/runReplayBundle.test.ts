import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DYNAMICS_RUN_FRAMES_HEADER_VERSION,
  DYNAMICS_RUN_FRAME_VERSION,
} from "./runFrames.js";
import { loadRunReplayBundle } from "./runReplayBundle.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = path.resolve(
  here,
  "..",
  "..",
  "fixtures",
  "observe",
  "office-sim-golden",
);

const hash = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

describe("run replay bundle viewer projection", () => {
  it("uses the sealed projection as the base before frame-track overlay", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "simfile-replay-projection-"));
    const runDir = path.join(temp, "run");
    try {
      await cp(GOLDEN_DIR, runDir, { recursive: true });
      const manifestPath = path.join(runDir, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        artifacts: Array<{ path: string; sha256: string }>;
        run_id: string;
        world: Record<string, unknown>;
      };
      const projection = {
        version: "viewer.trace.v1",
        run_id: manifest.run_id,
        run_name: "sealed projection base",
        rooms: [{
          id: "projection-room",
          kind: "room",
          label: "projection room",
          scope: "projection-room",
          members: ["projection-agent"],
          scene: [0, 0, 0],
        }],
        corridors: [],
        agents: [{
          id: "projection-agent",
          label: "projection agent",
          scope: "projection-agent",
        }],
        presence: [],
        ledger_facts: [],
        signals: [{
          id: "projection-signal",
          kind: "marker",
          label: "projection signal",
          scope: "projection-room",
          value: "present",
          detail: "generic producer-authored signal",
          scene: [0, 0, 0],
        }],
        spatial_samples: [{
          tick: 6,
          occupancy: {},
          transit: [],
        }],
      };
      const projectionBytes = Buffer.from(`${JSON.stringify(projection)}\n`);
      const projectionPath = "presentation/viewer.json";
      await mkdir(path.join(runDir, "presentation"));
      await writeFile(path.join(runDir, projectionPath), projectionBytes);

      const frameBytes = Buffer.from(`${JSON.stringify({
        bounds: { max: [5, 3], min: [-5, -3] },
        sim_seconds_per_tick: 0.04,
        version: DYNAMICS_RUN_FRAMES_HEADER_VERSION,
      })}\n${JSON.stringify({
        discontinuities: ["projection-agent"],
        objects: [
          { id: "projection-agent", position: [1, 1], velocity: [0, 0] },
          { id: "recorded-body", position: [2, 1], velocity: [0.5, 0] },
        ],
        occupancy: { "projection-room": ["projection-agent", "recorded-body"] },
        tick: 4,
        transit: [{ agent: "recorded-body", from_room: "projection-room",
          path_id: "recorded-path", ticks_remaining: 0,
          to_room: "projection-room" }],
        version: DYNAMICS_RUN_FRAME_VERSION,
      })}\n`);
      const framesPath = "raw/frames.jsonl";
      await writeFile(path.join(runDir, framesPath), frameBytes);

      manifest.world = {
        ...manifest.world,
        viewer_projection: projectionPath,
      };
      manifest.artifacts.push(
        { path: projectionPath, sha256: hash(projectionBytes) },
        { path: framesPath, sha256: hash(frameBytes) },
      );
      await writeFile(manifestPath, JSON.stringify(manifest));

      const bundle = await loadRunReplayBundle({
        mode: "replay",
        port: 0,
        sourcePath: runDir,
      });
      assert.ok(bundle);
      assert.equal(bundle.world.run_name, "sealed projection base");
      assert.deepEqual(bundle.world.signals, projection.signals);
      assert.deepEqual(
        bundle.world.agents.map(({ id }) => id),
        ["projection-agent", "recorded-body"],
      );
      assert.deepEqual(bundle.world.rooms.map(({ id }) => id), ["projection-room"]);
      assert.deepEqual(
        bundle.world.spatial_samples.map(({ tick }) => tick),
        [4, 6],
      );
      assert.deepEqual(bundle.world.spatial_samples[0]?.discontinuities,
        ["projection-agent"]);
      assert.deepEqual(bundle.world.spatial_samples[0]?.occupancy,
        { "projection-room": ["projection-agent", "recorded-body"] });
      assert.deepEqual(bundle.world.spatial_samples[0]?.transit, [{
        agent: "recorded-body", from_room: "projection-room",
        path_id: "recorded-path", ticks_remaining: 0,
        to_room: "projection-room",
      }]);
      assert.equal(bundle.world.tick_duration_ms, 40);
    } finally {
      await rm(temp, { force: true, recursive: true });
    }
  });
});
