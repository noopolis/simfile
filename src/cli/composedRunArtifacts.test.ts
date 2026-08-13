import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { ComposedArtifactRole } from "../compose/runRecord.js";
import type { LinkedComposedBootstrap } from "./composedRunBootstrap.js";
import { createLinkedComposedRecord } from "./composedRunArtifacts.js";

const requiredRoles = [
  "accepted-action", "action-result", "authority-export", "identity", "probe",
  "provenance", "terminal", "world-checkpoint", "world-frame",
] as const satisfies readonly ComposedArtifactRole[];

test("linked composed record seals declared viewer data and projection authority", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "simfile-linked-viewer-record-"));
  try {
    const projectRoot = path.join(root, "project");
    const assets = path.join(projectRoot, "assets");
    await mkdir(assets, { recursive: true });
    await writeFile(path.join(projectRoot, "extension.js"), "export {};\n");
    await writeFile(path.join(assets, "manifest.json"), "{}\n");
    await writeFile(path.join(projectRoot, "extension.json"), `${JSON.stringify({
      asset_root: "./assets",
      id: "fixture-renderer",
      module: "./extension.js",
      version: "simfile.viewer-extension.v1",
    })}\n`);
    await writeFile(path.join(projectRoot, "viewer-extensions.json"), `${JSON.stringify({
      extensions: [{ descriptor: "./extension.json", id: "fixture-renderer" }],
      version: "simfile.project-viewer-extensions.v1",
    })}\n`);
    const bootstrap = {
      compile_fingerprint: `sha256:${"1".repeat(32)}`,
      preparation: {
        viewer: {
          extensions: [{ id: "fixture-renderer",
            recorded_artifact: "presentation/viewer-trace.json" }],
          live_trace: {
            artifact: { id: "viewer_trace", max_bytes: 120_000,
              media_type: "application/json",
              path: "/tmp/spawnfile-public/viewer-trace.json" },
            extension_id: "fixture-renderer",
          },
          version: "simfile.composed-viewer-binding.v1",
        },
      },
      request: { world: {
        artifact_manifest_digest: `sha256:${"2".repeat(64)}`,
        bundle_digest: `sha256:${"3".repeat(64)}`,
        runtime_abi: "simfile.world-sidecar-runtime.v1",
      } },
      run_id: "linked-viewer-record",
      run_path: path.join(root, "run"),
      trusted_project_root: projectRoot,
    } as unknown as LinkedComposedBootstrap;
    const record = await createLinkedComposedRecord(bootstrap);
    await record.writeArtifact({
      bytes: Buffer.from("{}\n"),
      path: "presentation/viewer-trace.json",
      role: "presentation",
    });
    for (const [index, role] of requiredRoles.entries()) {
      await record.writeArtifact({
        bytes: Buffer.from(`${role}\n`),
        path: `test/${String(index).padStart(2, "0")}-${role}.txt`,
        role,
      });
    }
    const sealed = await record.seal();
    assert.deepEqual(sealed.manifest.world?.viewer_extension_data, {
      "fixture-renderer": "presentation/viewer-trace.json",
    });
    assert.equal(sealed.manifest.world?.viewer_projection,
      "presentation/viewer-trace.json");
    assert.equal(sealed.manifest.contract_versions["simfile.composed-viewer-binding.v1"],
      "simfile.composed-viewer-binding.v1");
    assert.equal(sealed.manifest.artifacts.some(({ path: artifactPath }) =>
      artifactPath === "viewer-extensions.json"), true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
