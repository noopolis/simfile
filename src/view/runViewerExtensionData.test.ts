import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  readRunViewerExtensionData,
  readStagingViewerExtensionData,
} from "./runViewerExtensionData.js";

const hash = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const fixture = async (
  declaration: unknown = { "fixture-renderer": "presentation/render.json" },
): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "simfile-extension-data-"));
  const bytes = Buffer.from("{\"some\":\"fixture-owned value\"}\n");
  await mkdir(path.join(root, "presentation"));
  await writeFile(path.join(root, "presentation", "render.json"), bytes);
  await writeFile(path.join(root, "manifest.json"), JSON.stringify({
    version: "simfile.run-manifest.v1",
    run_id: "run-1",
    created_at: "2026-08-05T00:00:00.000Z",
    contract_versions: {},
    artifacts: [{ path: "presentation/render.json", sha256: hash(bytes) }],
    world: { viewer_extension_data: declaration },
  }));
  return root;
};

describe("run viewer extension data", () => {
  it("loads an integrity-checked artifact without interpreting its payload", async () => {
    const root = await fixture();
    try {
      assert.deepEqual(await readRunViewerExtensionData(root), {
        "fixture-renderer": { some: "fixture-owned value" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed for traversal, unlisted files, and hash mismatch", async () => {
    for (const declaration of [
      { "fixture-renderer": "../render.json" },
      { "fixture-renderer": "presentation/unlisted.json" },
      { "Bad Id": "presentation/render.json" },
    ]) {
      const root = await fixture(declaration);
      try {
        await assert.rejects(readRunViewerExtensionData(root));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
    const root = await fixture();
    try {
      await writeFile(path.join(root, "presentation", "render.json"), "changed\n");
      await assert.rejects(readRunViewerExtensionData(root), /integrity failed/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a listed payload symlink that escapes the run directory", async () => {
    const root = await fixture();
    const outside = `${root}-outside.json`;
    try {
      await writeFile(outside, "{\"some\":\"fixture-owned value\"}\n");
      await rm(path.join(root, "presentation", "render.json"));
      await symlink(outside, path.join(root, "presentation", "render.json"));
      await assert.rejects(readRunViewerExtensionData(root), /escapes the run directory/u);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { force: true });
    }
  });

  it("loads an opaque hash-bound payload from an open staging directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-staging-extension-data-"));
    const bytes = Buffer.from("{\"some\":\"live value\"}\n");
    try {
      await mkdir(path.join(root, "presentation"));
      await writeFile(path.join(root, "presentation", "render.json"), bytes);
      await writeFile(path.join(root, "viewer-extension-data.json"), JSON.stringify({
        version: "simfile.viewer-extension-data.v1",
        extensions: [{
          id: "fixture-renderer",
          path: "presentation/render.json",
          sha256: hash(bytes),
        }],
      }));
      assert.deepEqual(await readStagingViewerExtensionData(root), {
        "fixture-renderer": { some: "live value" },
      });
      await writeFile(path.join(root, "presentation", "render.json"), "changed\n");
      await assert.rejects(readStagingViewerExtensionData(root), /integrity failed/u);
      await rm(path.join(root, "presentation", "render.json"));
      assert.equal(await readStagingViewerExtensionData(root), undefined);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
