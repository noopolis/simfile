import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { createComposedWorldServiceReceipt } from "../compose/startup-world.js";
import { digestComposedJson } from "../compose/json.js";
import type { ComposedViewerBinding } from "../compose/viewerBinding.js";
import {
  bindTerminalViewerProjection,
  startProductionViewerProjection,
} from "./productionViewerProjection.js";

const binding: ComposedViewerBinding = {
  extensions: [{ id: "fixture-renderer", recorded_artifact: "presentation/final.json" }],
  live_trace: {
    artifact: { id: "viewer_trace", max_bytes: 4_096,
      media_type: "application/json", path: "/tmp/spawnfile-public/viewer.json" },
    extension_id: "fixture-renderer",
  },
  version: "simfile.composed-viewer-binding.v1",
};
const selectedTarget = {
  fingerprint: `sha256:${"1".repeat(32)}`,
  handle: "opaque_1111111111111111",
};
const service = createComposedWorldServiceReceipt({
  resource_handle: "opaque_2222222222222222",
  run_id: "projection-run",
  service_handle: "opaque_3333333333333333",
});
const journal = {
  entries: [{ phase: "world_started_paused", payload: { receipt: service } }],
  request: { descriptor_digest: `sha256:${"4".repeat(64)}`, run_id: "projection-run" },
};

test("production viewer observer publishes only verified distinct snapshots", async () => {
  const content = Buffer.from(`${JSON.stringify({
    agents: [], corridors: [], ledger_facts: [], presence: [], rooms: [],
    run_id: "projection-run", run_name: "projection", signals: [],
    spatial_samples: [], version: "viewer.trace.v1",
  })}\n`);
  let calls = 0;
  let published = 0;
  let release!: () => void;
  const observed = new Promise<void>((resolve) => { release = resolve; });
  const observer = startProductionViewerProjection({
    binding,
    dependencies: {
      createDriver: () => ({
        load: () => Promise.resolve(journal as never),
        runTarget: (_command, request) => {
          calls += 1;
          return Promise.resolve({
            artifact_id: "viewer_trace",
            content_base64: content.toString("base64"),
            content_digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
            media_type: "application/json",
            request_digest: digestComposedJson(
              "spawnfile.target-public-artifact-snapshot.request.v1", request,
            ),
            run_id: "projection-run",
            size_bytes: content.byteLength,
            version: "spawnfile.target-public-artifact-snapshot.v1",
          });
        },
        selectedTarget,
      }),
      poll_ms: 1,
    },
    execution: {} as never,
    journal_session: {} as never,
    publish: async (bytes, source) => {
      assert.deepEqual(bytes, content);
      assert.equal(source.artifact_id, "viewer_trace");
      assert.equal(source.request.run_id, "projection-run");
      assert.equal(source.run_id, "projection-run");
      assert.equal(source.response_version,
        "spawnfile.target-public-artifact-snapshot.v1");
      published += 1;
      release();
    },
  });
  await observed;
  while (calls < 2) await new Promise((resolve) => setTimeout(resolve, 1));
  const result = await observer.close();
  assert.equal(published, 1);
  assert.equal(result.published_snapshots, 1);
  assert.equal(result.failed_snapshots, 0);
});

test("production viewer observer takes one final verified snapshot at pause", async () => {
  const content = (tick: number, status: "live" | "completed") => Buffer.from(
    `${JSON.stringify({
      agents: [], corridors: [], ledger_facts: [], playback_status: status,
      presence: [], rooms: [], run_id: "projection-run", run_name: "projection",
      signals: [], spatial_samples: [{ occupancy: {}, objects: [], tick, transit: [] }],
      version: "viewer.trace.v1",
    })}\n`,
  );
  let current = content(1, "live");
  let stopped = false;
  const mutableJournal = structuredClone(journal) as {
    entries: Array<{ phase: string; payload: Record<string, unknown> }>;
  } & typeof journal;
  let release!: () => void;
  const observed = new Promise<void>((resolve) => { release = resolve; });
  const ticks: number[] = [];
  const observer = startProductionViewerProjection({
    binding,
    dependencies: {
      createDriver: () => ({
        load: () => Promise.resolve(mutableJournal as never),
        runTarget: (_command, request) => {
          if (stopped) throw new Error("world container no longer exists");
          return Promise.resolve({
            artifact_id: "viewer_trace",
            content_base64: current.toString("base64"),
            content_digest: `sha256:${createHash("sha256").update(current).digest("hex")}`,
            media_type: "application/json",
            request_digest: digestComposedJson(
              "spawnfile.target-public-artifact-snapshot.request.v1", request,
            ),
            run_id: "projection-run",
            size_bytes: current.byteLength,
            version: "spawnfile.target-public-artifact-snapshot.v1",
          });
        },
        selectedTarget,
      }),
      poll_ms: 60_000,
    },
    execution: {} as never,
    journal_session: {} as never,
    publish: async (bytes) => {
      const trace = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
        spatial_samples: Array<{ tick: number }>;
      };
      ticks.push(trace.spatial_samples[0]!.tick);
      release();
    },
  });
  await observed;
  current = content(2, "completed");
  mutableJournal.entries.push({ phase: "terminal", payload: {} });
  const bound = bindTerminalViewerProjection({
    exportWorldEvidence: async () => "evidence",
    pauseWorld: async () => { stopped = true; return "paused"; },
  }, observer);
  assert.equal(await bound.pauseWorld({} as never), "paused");
  const result = await observer.close();
  assert.deepEqual(ticks, [1, 2]);
  assert.equal(result.published_snapshots, 2);
  assert.equal(result.failed_snapshots, 0);
});

test("terminal capture precedes destructive pause and cannot fail the lifecycle", async () => {
  for (const reject of [false, true]) {
    const order: string[] = [];
    const bound = bindTerminalViewerProjection({
      exportWorldEvidence: async () => { order.push("export"); return "evidence"; },
      pauseWorld: async () => { order.push("pause"); return "paused"; },
    }, {
      captureTerminal: async () => {
        order.push("capture");
        if (reject) throw new Error("observer unavailable");
      },
      close: async () => ({ failed_snapshots: 0, published_snapshots: 0 }),
    });
    assert.equal(await bound.pauseWorld({} as never), "paused");
    assert.deepEqual(order, ["capture", "pause"]);
    assert.equal(await bound.exportWorldEvidence({} as never), "evidence");
    assert.deepEqual(order, ["capture", "pause", "export"]);
  }
});
