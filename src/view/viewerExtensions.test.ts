import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createViewerServer } from "./server.js";
import { loadViewerExtensionDescriptors } from "./viewerExtensions.js";

const createDescriptor = async (): Promise<{
  descriptor: string;
  root: string;
}> => {
  const root = await mkdtemp(path.join(tmpdir(), "simfile-viewer-extension-"));
  const assets = path.join(root, "prepared-assets");
  await mkdir(assets);
  await writeFile(path.join(root, "extension.js"), "globalThis.fixtureLoaded = true;\n");
  await writeFile(path.join(assets, "manifest.json"), "{\"ready\":true}\n");
  const descriptor = path.join(root, "extension.json");
  await writeFile(descriptor, `${JSON.stringify({
    asset_root: "./prepared-assets",
    id: "fixture-renderer",
    module: "./extension.js",
    version: "simfile.viewer-extension.v1",
  })}\n`);
  return { descriptor, root };
};

test("loads and serves an explicit viewer extension in the console origin", async () => {
  const fixture = await createDescriptor();
  const extensions = await loadViewerExtensionDescriptors([fixture.descriptor]);
  assert.equal(extensions.length, 1);
  const server = await createViewerServer({
    extensions,
    mode: "replay",
    port: 0,
    sourcePath: fixture.root,
  });
  try {
    const index = await fetch(`${server.url}/api/viewer-extensions`);
    assert.deepEqual(await index.json(), {
      version: "simfile.viewer-extensions.v1",
      extensions: [{
        asset_root: "/_simfile/viewer-extensions/fixture-renderer/assets",
        id: "fixture-renderer",
        module_url: "/_simfile/viewer-extensions/fixture-renderer/module.js",
      }],
    });
    const module = await fetch(
      `${server.url}/_simfile/viewer-extensions/fixture-renderer/module.js`,
    );
    assert.equal(module.status, 200);
    assert.equal(module.headers.get("content-type"), "application/javascript; charset=utf-8");
    assert.match(await module.text(), /fixtureLoaded/u);
    const asset = await fetch(
      `${server.url}/_simfile/viewer-extensions/fixture-renderer/assets/manifest.json`,
    );
    assert.equal(asset.status, 200);
    assert.deepEqual(await asset.json(), { ready: true });
  } finally {
    await server.close();
  }
});

test("extension descriptors fail closed on aliases, schema drift, and duplicates", async () => {
  const fixture = await createDescriptor();
  const alias = path.join(fixture.root, "alias.json");
  await symlink(fixture.descriptor, alias);
  await assert.rejects(
    loadViewerExtensionDescriptors([alias]),
    /non-symlink file/u,
  );
  await assert.rejects(
    loadViewerExtensionDescriptors([fixture.descriptor, fixture.descriptor]),
    /invalid viewer extension descriptor/u,
  );
  await writeFile(fixture.descriptor, JSON.stringify({
    asset_root: "./prepared-assets",
    extra: true,
    id: "fixture-renderer",
    module: "./extension.js",
    version: "simfile.viewer-extension.v1",
  }));
  await assert.rejects(
    loadViewerExtensionDescriptors([fixture.descriptor]),
    /invalid viewer extension descriptor/u,
  );
});
