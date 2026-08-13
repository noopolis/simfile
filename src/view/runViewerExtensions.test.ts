import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  loadRunViewerExtensionPlan,
  loadRunViewerExtensions,
} from "./runViewerExtensions.js";
import {
  loadViewerExtensionDescriptors,
  type ViewerExtensionMount,
} from "./viewerExtensions.js";

const descriptorToken = "./dist/viewer/renderer.json";

const writeExtension = async (
  root: string,
  id = "declared-renderer",
): Promise<string> => {
  const output = path.join(root, "dist", "viewer");
  const assets = path.join(root, "assets");
  await Promise.all([
    mkdir(output, { recursive: true }),
    mkdir(assets, { recursive: true }),
  ]);
  await writeFile(path.join(output, "module.js"), "export {};\n");
  await writeFile(path.join(assets, "style.css"), ".ready{}\n");
  const descriptor = path.join(output, "renderer.json");
  await writeFile(descriptor, JSON.stringify({
    asset_root: "../../assets",
    id,
    module: "./module.js",
    version: "simfile.viewer-extension.v1",
  }));
  return descriptor;
};

const writeTrustedDeclaration = async (
  root: string,
  descriptor = descriptorToken,
): Promise<void> => {
  await writeFile(path.join(root, "viewer-extensions.json"), JSON.stringify({
    version: "simfile.project-viewer-extensions.v1",
    extensions: [{ descriptor, id: "declared-renderer" }],
  }));
};

const writeRecord = async (
  runDir: string,
  mount: ViewerExtensionMount,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<void> => {
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "manifest.json"), "{}\n");
  await writeFile(path.join(runDir, "viewer-extensions.json"), JSON.stringify({
    version: "simfile.project-viewer-extensions.v1",
    extensions: [{
      asset_tree_sha256: mount.assetTreeSha256,
      descriptor: descriptorToken,
      id: mount.id,
      module_sha256: mount.moduleSha256,
      ...overrides,
    }],
  }));
};

const trustedFixture = async (): Promise<{
  descriptor: string;
  mount: ViewerExtensionMount;
  project: string;
}> => {
  const project = await mkdtemp(path.join(tmpdir(), "simfile-trusted-viewer-"));
  const descriptor = await writeExtension(project);
  await writeTrustedDeclaration(project);
  const [mount] = await loadViewerExtensionDescriptors([descriptor]);
  assert.ok(mount);
  return { descriptor, mount, project };
};

describe("recorded viewer extension verification", () => {
  it("loads code only through the trusted local mapping", async () => {
    const { mount, project } = await trustedFixture();
    const root = await mkdtemp(path.join(tmpdir(), "simfile-recorded-viewer-"));
    const runDir = path.join(root, "run");
    try {
      await writeRecord(runDir, mount);
      await writeFile(path.join(runDir, "provenance.json"), JSON.stringify({
        source: { path: path.join(root, "hostile", "Simfile") },
      }));
      const plan = await loadRunViewerExtensionPlan({
        explicitDescriptors: [], ignoreRecorded: false, runDir, trustedRoot: project,
      });
      assert.equal(plan.mounts[0]?.descriptorPath, mount.descriptorPath);
      assert.deepEqual(plan.identities, [{ id: mount.id, status: "recorded" }]);
    } finally {
      await Promise.all([
        rm(project, { force: true, recursive: true }),
        rm(root, { force: true, recursive: true }),
      ]);
    }
  });

  it("reconciles a live startup mount against the later seal", async () => {
    const { mount, project } = await trustedFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), "simfile-live-viewer-"));
    try {
      const plan = await loadRunViewerExtensionPlan({
        explicitDescriptors: [], ignoreRecorded: false, runDir, trustedRoot: project,
      });
      assert.deepEqual(plan.identities, [{ id: mount.id, status: "unsealed/local" }]);
      assert.ok(plan.reconcileAtSeal);
      await writeRecord(runDir, mount);
      assert.deepEqual(await plan.reconcileAtSeal(), [
        { id: mount.id, status: "recorded" },
      ]);
    } finally {
      await Promise.all([
        rm(project, { force: true, recursive: true }),
        rm(runDir, { force: true, recursive: true }),
      ]);
    }
  });

  it("fails closed without a trusted mapping and on a recorded path redirect", async () => {
    const { mount, project } = await trustedFixture();
    const root = await mkdtemp(path.join(tmpdir(), "simfile-untrusted-viewer-"));
    const runDir = path.join(root, "run");
    try {
      await writeRecord(runDir, mount);
      await assert.rejects(loadRunViewerExtensions({
        explicitDescriptors: [], ignoreRecorded: false, runDir, trustedRoot: root,
      }), /trusted local mapping/u);

      await writeRecord(runDir, mount, { descriptor: "./dist/viewer/redirect.json" });
      await assert.rejects(loadRunViewerExtensions({
        explicitDescriptors: [], ignoreRecorded: false, runDir, trustedRoot: project,
      }), /does not corroborate/u);
    } finally {
      await Promise.all([
        rm(project, { force: true, recursive: true }),
        rm(root, { force: true, recursive: true }),
      ]);
    }
  });

  it("fails closed on a recorded digest mismatch and changed startup bytes", async () => {
    const { mount, project } = await trustedFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), "simfile-digest-viewer-"));
    try {
      await writeRecord(runDir, mount, { module_sha256: "0".repeat(64) });
      await assert.rejects(loadRunViewerExtensions({
        explicitDescriptors: [], ignoreRecorded: false, runDir, trustedRoot: project,
      }), /does not corroborate/u);

      await rm(path.join(runDir, "manifest.json"));
      await rm(path.join(runDir, "viewer-extensions.json"));
      const plan = await loadRunViewerExtensionPlan({
        explicitDescriptors: [], ignoreRecorded: false, runDir, trustedRoot: project,
      });
      await writeRecord(runDir, mount);
      await writeFile(path.join(project, "dist", "viewer", "module.js"), "changed\n");
      await assert.rejects(plan.reconcileAtSeal!(), /changed after startup/u);
    } finally {
      await Promise.all([
        rm(project, { force: true, recursive: true }),
        rm(runDir, { force: true, recursive: true }),
      ]);
    }
  });

  it("keeps extension-free records generic and ignores malformed records on request", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-generic-viewer-"));
    try {
      await writeFile(path.join(root, "manifest.json"), "{}\n");
      assert.deepEqual(await loadRunViewerExtensions({
        explicitDescriptors: [], ignoreRecorded: false, runDir: root, trustedRoot: root,
      }), []);
      await writeFile(path.join(root, "viewer-extensions.json"), "not json");
      assert.deepEqual(await loadRunViewerExtensions({
        explicitDescriptors: [], ignoreRecorded: true, runDir: root, trustedRoot: root,
      }), []);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
