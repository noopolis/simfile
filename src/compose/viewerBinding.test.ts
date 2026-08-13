import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseComposedViewerBinding } from "./viewerBinding.js";

const artifacts = [
  { path: "presentation/world.json", role: "presentation" as const },
  { path: "probe/final.json", role: "probe" as const },
];
const binding = () => ({
  extensions: [{
    id: "fixture-renderer",
    recorded_artifact: "presentation/world.json",
  }],
  live_trace: {
    artifact: {
      id: "viewer_trace",
      max_bytes: 120_000,
      media_type: "application/json",
      path: "/tmp/spawnfile-public/viewer-trace.json",
    },
    extension_id: "fixture-renderer",
  },
  version: "simfile.composed-viewer-binding.v1",
});

describe("composed viewer binding", () => {
  it("binds one live public trace to one recorded presentation artifact", () => {
    assert.deepEqual(parseComposedViewerBinding(binding(), artifacts), binding());
    assert.equal(parseComposedViewerBinding(undefined, artifacts), undefined);
  });

  it("rejects missing, wrong-role, duplicate, and unknown extension bindings", () => {
    for (const value of [
      { ...binding(), extensions: [{ id: "fixture-renderer",
        recorded_artifact: "missing.json" }] },
      { ...binding(), extensions: [{ id: "fixture-renderer",
        recorded_artifact: "probe/final.json" }] },
      { ...binding(), extensions: [binding().extensions[0], binding().extensions[0]] },
      { ...binding(), live_trace: { ...binding().live_trace,
        extension_id: "other-renderer" } },
    ]) assert.throws(
      () => parseComposedViewerBinding(value, artifacts),
      /composed viewer binding is invalid|Invalid input/u,
    );
  });

  it("rejects path escapes and malformed public artifact declarations", () => {
    for (const value of [
      { ...binding(), extensions: [{ id: "fixture-renderer",
        recorded_artifact: "../world.json" }] },
      { ...binding(), live_trace: { ...binding().live_trace,
        artifact: { ...binding().live_trace.artifact, path: "/tmp/private/view.json" } } },
      { ...binding(), live_trace: { ...binding().live_trace,
        artifact: { ...binding().live_trace.artifact,
          path: "/tmp/spawnfile-public/../private.json" } } },
      { ...binding(), live_trace: { ...binding().live_trace,
        artifact: { ...binding().live_trace.artifact,
          path: `/tmp/spawnfile-public/${"a".repeat(240)}.json` } } },
      { ...binding(), live_trace: { ...binding().live_trace,
        artifact: { ...binding().live_trace.artifact, max_bytes: 131_073 } } },
      { ...binding(), live_trace: { ...binding().live_trace,
        artifact: { ...binding().live_trace.artifact, media_type: "text/plain" } } },
    ]) assert.throws(() => parseComposedViewerBinding(value, artifacts));
  });
});
