import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ComposedProjectPreparation } from "../compose/projectBinding.js";
import type { LoadedProjectViewerExtensions } from
  "../viewer-extension/projectDeclaration.js";
import { linkedComposedViewerManifestFields } from "./composedViewerBinding.js";

const preparation = (id = "fixture-renderer") => ({
  viewer: {
    extensions: [{ id, recorded_artifact: "presentation/world.json" }],
    live_trace: {
      artifact: { id: "viewer_trace", max_bytes: 120_000,
        media_type: "application/json", path: "/tmp/spawnfile-public/viewer.json" },
      extension_id: id,
    },
    version: "simfile.composed-viewer-binding.v1",
  },
}) as unknown as ComposedProjectPreparation;
const project = {
  declaration: {
    extensions: [{ descriptor: "./dist/renderer.json", id: "fixture-renderer" }],
    version: "simfile.project-viewer-extensions.v1",
  },
} as unknown as LoadedProjectViewerExtensions;

describe("linked composed viewer manifest fields", () => {
  it("maps one trusted extension to one recorded trace", () => {
    assert.deepEqual(linkedComposedViewerManifestFields(preparation(), project), {
      viewer_extension_data: { "fixture-renderer": "presentation/world.json" },
      viewer_projection: "presentation/world.json",
    });
    assert.equal(linkedComposedViewerManifestFields(
      {} as ComposedProjectPreparation, project,
    ), undefined);
  });

  it("rejects an extension id absent from the trusted project declaration", () => {
    assert.throws(
      () => linkedComposedViewerManifestFields(preparation("other-renderer"), project),
      /undeclared extension/u,
    );
  });
});
