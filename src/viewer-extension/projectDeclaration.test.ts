import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  emptyProjectViewerExtensionsBytes,
  loadProjectViewerExtensions,
  parseProjectViewerExtensions,
} from "./projectDeclaration.js";

const declaration = (descriptor = "./dist/viewer/renderer.json") => Buffer.from(
  JSON.stringify({
    version: "simfile.project-viewer-extensions.v1",
    extensions: [{ descriptor, id: "declared-renderer" }],
  }),
);

describe("project viewer extension declarations", () => {
  it("accepts only the exact versioned declaration shape", () => {
    assert.deepEqual(parseProjectViewerExtensions(declaration()), {
      extensions: [{
        descriptor: "./dist/viewer/renderer.json",
        id: "declared-renderer",
      }],
      version: "simfile.project-viewer-extensions.v1",
    });
    const digest = "a".repeat(64);
    assert.deepEqual(parseProjectViewerExtensions(Buffer.from(JSON.stringify({
      version: "simfile.project-viewer-extensions.v1",
      extensions: [{
        asset_tree_sha256: digest,
        descriptor: "./dist/viewer/renderer.json",
        id: "declared-renderer",
        module_sha256: digest,
      }],
    }))).extensions[0], {
      asset_tree_sha256: digest,
      descriptor: "./dist/viewer/renderer.json",
      id: "declared-renderer",
      module_sha256: digest,
    });
    for (const raw of [
      { version: "simfile.project-viewer-extensions.v1", extensions: [], extra: true },
      { version: "other", extensions: [] },
      { version: "simfile.project-viewer-extensions.v1", extensions: [{ descriptor: "./a.json", id: "x", extra: true }] },
      { version: "simfile.project-viewer-extensions.v1", extensions: [{
        descriptor: "./a.json", id: "x", module_sha256: digest,
      }] },
      { version: "simfile.project-viewer-extensions.v1", extensions: [{
        asset_tree_sha256: digest,
        descriptor: "./a.json",
        id: "x",
        module_sha256: "not-a-digest",
      }] },
      { version: "simfile.project-viewer-extensions.v1", extensions: [
        { descriptor: "./a.json", id: "same" },
        { descriptor: "./b.json", id: "same" },
      ] },
    ]) {
      assert.throws(
        () => parseProjectViewerExtensions(Buffer.from(JSON.stringify(raw))),
        /invalid simfile\.project-viewer-extensions\.v1 declaration/u,
      );
    }
  });

  it("rejects paths with every forbidden escape shape", () => {
    for (const descriptor of [
      "/absolute.json",
      "C:/absolute.json",
      "file:extension.json",
      ".\\extension.json",
      "./bad\0.json",
      "./extension.json?query",
      "./extension.json#fragment",
      "./nested/../extension.json",
      "./extension.js",
      "dist/extension.json",
    ]) {
      assert.throws(
        () => parseProjectViewerExtensions(declaration(descriptor)),
        /invalid simfile\.project-viewer-extensions\.v1 declaration/u,
        descriptor,
      );
    }
  });

  it("preserves committed bytes and supplies canonical empty bytes when absent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-project-viewer-"));
    try {
      const simfile = path.join(root, "Simfile");
      await writeFile(simfile, "name: test\nclock:\n  seed: test\n  tick: 1s\n");
      const empty = await loadProjectViewerExtensions(simfile);
      assert.deepEqual(empty.bytes, emptyProjectViewerExtensionsBytes());

      const committed = `${JSON.stringify({
        version: "simfile.project-viewer-extensions.v1",
        extensions: [{ descriptor: "./dist/renderer.json", id: "renderer" }],
      }, null, 2)}\n`;
      await writeFile(path.join(root, "viewer-extensions.json"), committed);
      const loaded = await loadProjectViewerExtensions(simfile);
      assert.deepEqual(loaded.bytes, await readFile(path.join(root, "viewer-extensions.json")));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
