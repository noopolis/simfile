import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { ComposedRunArtifactInput } from "./runRecord.js";
import type { ComposedViewerBinding } from "./viewerBinding.js";
import { createComposedLiveViewerProjection } from "./liveViewerProjection.js";
import { digestComposedJson } from "./json.js";

const binding: ComposedViewerBinding = {
  extensions: [{ id: "fixture-renderer", recorded_artifact: "presentation/final.json" }],
  live_trace: {
    artifact: { id: "viewer_trace", max_bytes: 4_096,
      media_type: "application/json", path: "/tmp/spawnfile-public/viewer.json" },
    extension_id: "fixture-renderer",
  },
  version: "simfile.composed-viewer-binding.v1",
};
const trace = (ticks: readonly number[]) => Buffer.from(`${JSON.stringify({
  agents: [], corridors: [], ledger_facts: [], presence: [],
  rooms: [{ id: "floor", kind: "square", label: "floor", members: [],
    scale: [20, 10], scene: [0, 0, 0], scope: "world://floor" }],
  run_id: "viewer-run", run_name: "viewer run", signals: [],
  spatial_samples: ticks.map((tick) => ({
    ...(tick === 4 ? { discontinuities: ["ball"] } : {}),
    occupancy: { floor: ["ball"] },
    objects: [{ id: "ball", position: [tick, 0], velocity: [1, 0] }],
    tick,
    transit: tick === 4 ? [{ agent: "ball", from_room: "floor",
      path_id: "restart", ticks_remaining: 0, to_room: "floor" }] : [],
  })),
  tick_duration_ms: 20, version: "viewer.trace.v1",
})}\n`);
const source = (bytes: Uint8Array) => {
  const request = {
    artifact: binding.live_trace!.artifact,
    descriptor_digest: `sha256:${"d".repeat(64)}`,
    run_id: "viewer-run",
    selected_target: { fingerprint: `sha256:${"1".repeat(32)}`,
      handle: "opaque_1111111111111111" },
    version: "spawnfile.target-public-artifact-snapshot.request.v1",
    world_service_handle: "opaque_2222222222222222",
  };
  return {
  artifact_id: "viewer_trace",
  content_digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  media_type: "application/json",
  request,
  request_digest: digestComposedJson(
    "spawnfile.target-public-artifact-snapshot.request.v1", request,
  ),
  response_version: "spawnfile.target-public-artifact-snapshot.v1" as const,
  run_id: "viewer-run",
  size_bytes: bytes.byteLength,
  };
};

describe("composed live viewer projection", () => {
  it("mirrors exact snapshots and seals a monotonic generic frame prefix", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-composed-live-viewer-"));
    try {
      const projection = createComposedLiveViewerProjection({
        binding, run_id: "viewer-run", staging_dir: root,
      });
      const first = trace([1, 2]);
      const second = trace([1, 2, 4]);
      await projection.publish(first, source(first));
      await projection.publish(second, source(second));
      const declaration = JSON.parse(await readFile(
        path.join(root, "viewer-extension-data.json"), "utf8",
      )) as { extensions: Array<{ path: string; sha256: string }> };
      const current = await readFile(path.join(root, declaration.extensions[0]!.path));
      assert.deepEqual(current, second);
      assert.equal(createHash("sha256").update(current).digest("hex"),
        declaration.extensions[0]!.sha256);
      const artifacts: ComposedRunArtifactInput[] = [];
      const result = await projection.finalize({
        writeArtifacts: (entries) => { artifacts.push(...entries); return Promise.resolve(); },
      });
      assert.deepEqual(result, { frontier_tick: 4, publications: 2 });
      const frames = Buffer.from(artifacts.find(({ path: value }) =>
        value === "raw/frames.jsonl")!.bytes).toString("utf8").trim().split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.deepEqual(frames.slice(1).map(({ tick }) => tick), [1, 2, 4]);
      assert.deepEqual(frames.at(-1)?.discontinuities, ["ball"]);
      assert.deepEqual(frames.at(-1)?.occupancy, { floor: ["ball"] });
      assert.deepEqual(frames.at(-1)?.transit, [{ agent: "ball",
        from_room: "floor", path_id: "restart", ticks_remaining: 0,
        to_room: "floor" }]);
      const ledger = Buffer.from(artifacts.find(({ path: value }) =>
        value === "provenance/viewer-projection-sources.jsonl")!.bytes)
        .toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as {
          content_digest: string;
          request: Record<string, unknown>;
          request_digest: string;
          snapshot_path: string;
        });
      assert.equal(ledger.length, 2);
      for (const row of ledger) {
        assert.equal(row.request_digest, digestComposedJson(
          "spawnfile.target-public-artifact-snapshot.request.v1", row.request,
        ));
        const snapshot = artifacts.find(({ path: value }) => value === row.snapshot_path);
        assert.ok(snapshot);
        assert.equal(row.content_digest,
          `sha256:${createHash("sha256").update(snapshot.bytes).digest("hex")}`);
      }
      await assert.rejects(readFile(path.join(root, "viewer-extension-data.json")));
      await assert.rejects(projection.publish(second, source(second)), /closed/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects identity and digest drift without poisoning a later publication", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-composed-live-viewer-"));
    try {
      const projection = createComposedLiveViewerProjection({
        binding, run_id: "viewer-run", staging_dir: root,
      });
      const bytes = trace([1]);
      await assert.rejects(projection.publish(bytes, {
        ...source(bytes), content_digest: `sha256:${"b".repeat(64)}`,
      }), /source is invalid/u);
      await projection.publish(bytes, source(bytes));
      const stale = trace([0]);
      await assert.rejects(projection.publish(stale, source(stale)),
        /frontier regressed/u);
      const terminalRaw = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      terminalRaw.playback_status = "completed";
      const terminal = Buffer.from(`${JSON.stringify(terminalRaw)}\n`);
      await projection.publish(terminal, source(terminal));
      assert.deepEqual(await projection.finalize({
        writeArtifacts: () => Promise.resolve(),
      }), { frontier_tick: 1, publications: 2 });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rolls back a rejected publication without sealing unledgered frame rows", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-composed-live-viewer-"));
    try {
      let failed = false;
      const projection = createComposedLiveViewerProjection({
        binding,
        dependencies: { before_write: (relative) => {
          if (!failed && relative === "viewer-extension-data.json") {
            failed = true;
            throw new Error("injected declaration failure");
          }
        } },
        run_id: "viewer-run", staging_dir: root,
      });
      const bytes = trace([1]);
      await assert.rejects(projection.publish(bytes, source(bytes)),
        /injected declaration failure/u);
      assert.deepEqual(await projection.finalize({
        writeArtifacts: () => Promise.resolve(),
      }), { frontier_tick: -1, publications: 0 });
      await assert.rejects(readFile(path.join(root, "raw", "frames.jsonl")), /ENOENT/u);
      await assert.rejects(readFile(path.join(root, "provenance",
        "viewer-projection-sources.jsonl")), /ENOENT/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
