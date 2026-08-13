import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createComposedLiveViewerProjection } from "./liveViewerProjection.js";
import { createComposedRunRecord } from "./runRecord.js";
import type { ComposedViewerBinding } from "./viewerBinding.js";
import { attachComposedViewer } from "./viewer.js";
import { digestComposedJson } from "./json.js";

const liveBinding: ComposedViewerBinding = {
  extensions: [{ id: "fixture-renderer", recorded_artifact: "presentation/final.json" }],
  live_trace: {
    artifact: { id: "viewer_trace", max_bytes: 4_096,
      media_type: "application/json", path: "/tmp/spawnfile-public/viewer.json" },
    extension_id: "fixture-renderer",
  },
  version: "simfile.composed-viewer-binding.v1",
};

describe("composed viewer attachment", () => {
  it("returns one URL plus bounded observer seal and close handles", async () => {
    let closed = false;
    const result = await attachComposedViewer({
      dependencies: {
        createServer: async () => ({
          awaitSeal: () => Promise.resolve({ identities: [], status: "recorded" }),
          close: async () => { closed = true; }, url: "http://127.0.0.1:45123",
        }),
        loadExtensionPlan: async () => ({ identities: [], mounts: [] }),
      },
      run_dir: "/run/record", trusted_project_root: "/project",
    });
    assert.equal(result.state, "attached");
    if (result.state !== "attached") return;
    assert.deepEqual(Object.keys(result).sort(), ["awaitSeal", "close", "state", "url"]);
    assert.equal((await result.awaitSeal()).status, "recorded");
    assert.equal(result.url, "http://127.0.0.1:45123");
    await result.close();
    assert.equal(closed, true);
  });

  it("turns extension and renderer failures into non-mechanical evidence", async () => {
    for (const stage of ["extension", "server"] as const) {
      let serverCalls = 0;
      const result = await attachComposedViewer({
        dependencies: {
          createServer: async () => {
            serverCalls += 1;
            throw new Error("renderer failed");
          },
          loadExtensionPlan: async () => {
            if (stage === "extension") throw new Error("extension digest mismatch");
            return { identities: [], mounts: [] };
          },
        },
        run_dir: "/run/record", trusted_project_root: "/project",
      });
      assert.equal(result.state, "unavailable");
      assert.equal(serverCalls, stage === "extension" ? 0 : 1);
      if (result.state === "unavailable") assert.match(result.error, /failed|mismatch/u);
    }
  });

  it("follows the reserved output path into the composed staging projection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-composed-viewer-"));
    const project = path.join(root, "project");
    const outDir = path.join(root, "run");
    await mkdir(project);
    const record = await createComposedRunRecord({
      identity: {
        contract_versions: {}, created_at: new Date().toISOString(), run_id: "live-viewer-run",
      },
      out_dir: outDir,
    });
    let attachment;
    let streamAbort: AbortController | undefined;
    try {
      attachment = await attachComposedViewer({
        run_dir: record.out_dir,
        trusted_project_root: project,
      });
      assert.equal(attachment.state, "attached");
      if (attachment.state !== "attached") return;
      const projection = createComposedLiveViewerProjection({
        binding: liveBinding, run_id: "live-viewer-run", staging_dir: record.staging_dir,
      });
      const bytes = Buffer.from(`${JSON.stringify({
        agents: [], corridors: [], ledger_facts: [], presence: [],
        rooms: [{ id: "floor", kind: "square", label: "floor", members: [],
          scale: [10, 6], scene: [0, 0, 0], scope: "world://floor" }],
        run_id: "live-viewer-run", run_name: "live viewer", signals: [],
        spatial_samples: [{ occupancy: {}, objects: [{ id: "ball", position: [1, 2],
          velocity: [0, 0] }], tick: 3, transit: [] }],
        version: "viewer.trace.v1",
      })}\n`);
      const request = {
        artifact: liveBinding.live_trace!.artifact,
        descriptor_digest: `sha256:${"d".repeat(64)}`,
        run_id: "live-viewer-run",
        selected_target: { fingerprint: `sha256:${"1".repeat(32)}`,
          handle: "opaque_1111111111111111" },
        version: "spawnfile.target-public-artifact-snapshot.request.v1",
        world_service_handle: "opaque_2222222222222222",
      };
      const publish = (snapshot: Uint8Array) => projection.publish(snapshot, {
          artifact_id: "viewer_trace",
          content_digest: `sha256:${createHash("sha256").update(snapshot).digest("hex")}`,
          media_type: "application/json",
          request,
          request_digest: digestComposedJson(
            "spawnfile.target-public-artifact-snapshot.request.v1", request,
          ),
          response_version: "spawnfile.target-public-artifact-snapshot.v1",
          run_id: "live-viewer-run",
          size_bytes: snapshot.byteLength,
        });
      await publish(bytes);
      const state = await (await fetch(`${attachment.url}/api/state`)).json() as {
        mode: string;
      };
      const world = await (await fetch(`${attachment.url}/api/world`)).json() as {
        trace: { spatial_samples: unknown[]; viewer_extension_data?: Record<string, unknown> };
      };
      assert.equal(state.mode, "run-live");
      assert.equal(world.trace.spatial_samples.length, 1);
      assert.ok(world.trace.viewer_extension_data?.["fixture-renderer"]);

      streamAbort = new AbortController();
      const response = await fetch(`${attachment.url}/api/run-frames`, {
        signal: streamAbort.signal,
      });
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buffered = "";
      const readChunk = (): Promise<ReadableStreamReadResult<string>> =>
        new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(
            new Error("viewer extension stream timed out")), 2_000);
          void reader.read().then(resolve, reject).finally(() => clearTimeout(timeout));
        });
      const nextExtension = async (): Promise<Record<string, unknown>> => {
        for (;;) {
          const boundary = buffered.indexOf("\n\n");
          if (boundary >= 0) {
            const block = buffered.slice(0, boundary);
            buffered = buffered.slice(boundary + 2);
            const data = block.split("\n").find((line) => line.startsWith("data: "));
            if (data !== undefined) {
              const payload = JSON.parse(data.slice(6)) as Record<string, unknown>;
              if (payload.type === "viewer-extension-data") return payload;
            }
            continue;
          }
          const chunk = await readChunk();
          if (chunk.done) throw new Error("viewer frame stream ended before extension data");
          buffered += chunk.value;
        }
      };
      await nextExtension();
      const terminalRaw = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      terminalRaw.playback_status = "completed";
      await publish(Buffer.from(`${JSON.stringify(terminalRaw)}\n`));
      const terminalEvent = await nextExtension() as {
        extensionData?: { "fixture-renderer"?: { playback_status?: string } };
      };
      assert.equal(terminalEvent.extensionData?.["fixture-renderer"]?.playback_status,
        "completed");
    } finally {
      streamAbort?.abort();
      if (attachment?.state === "attached") await attachment.close();
      await record.abort();
      await rm(root, { force: true, recursive: true });
    }
  });
});
