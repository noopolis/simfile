import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { parseRunManifest, RUN_MANIFEST_VERSION } from "../observe/manifest.js";
import {
  createDynamicsRunArtifactWriter,
  dynamicsRunStagingPrefix,
  type DynamicsRunArtifactWriter
} from "../run/dynamics-run-artifacts.js";
import { findInProgressDynamicsRun } from "./runFollowLocator.js";

const populate = async (writer: DynamicsRunArtifactWriter): Promise<string> => {
  const artifactPath = `dynamics/sha256-${"a".repeat(64)}/provider.mjs`;
  await mkdir(path.join(writer.stagingRealPath, path.dirname(artifactPath)), {
    recursive: true
  });
  await writeFile(path.join(writer.stagingRealPath, "dynamics/build-receipt.json"), "{}\n");
  await writeFile(path.join(writer.stagingRealPath, artifactPath), "export {};\n");
  await writer.writeJson("provenance.json", {});
  await writer.writeJson("replay/action-stream.json", {});
  await writer.writeJson("replay/final-session.json", {});
  await writer.writeJson("replay/initial-session.json", {});
  await writer.writeJson("summary.json", {});
  await writer.writeBytes(
    "viewer-extensions.json",
    Buffer.from("{\"extensions\":[],\"version\":\"simfile.project-viewer-extensions.v1\"}\n")
  );
  return artifactPath;
};

describe("findInProgressDynamicsRun", () => {
  it("returns the real staging path for an open writer and undefined after seal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-follow-open-"));
    try {
      const outDir = path.join(root, "run");
      const writer = await createDynamicsRunArtifactWriter({ outDir });
      assert.equal(await findInProgressDynamicsRun(outDir), writer.stagingRealPath);
      const evidenceArtifactPath = await populate(writer);
      await writer.seal({
        evidenceArtifactPath,
        manifestFactory: (artifacts) => parseRunManifest({
          version: RUN_MANIFEST_VERSION,
          run_id: "locate",
          created_at: new Date(0).toISOString(),
          contract_versions: {},
          artifacts
        })
      });
      assert.equal(await findInProgressDynamicsRun(outDir), undefined);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("throws naming both matching directories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-follow-ambiguous-"));
    try {
      const outDir = path.join(root, "run");
      const prefix = dynamicsRunStagingPrefix(outDir);
      const first = `${prefix}first`;
      const second = `${prefix}second`;
      await mkdir(path.join(root, first));
      await mkdir(path.join(root, second));
      await assert.rejects(
        findInProgressDynamicsRun(outDir),
        (failure: unknown) => {
          assert.match(String(failure), new RegExp(first));
          assert.match(String(failure), new RegExp(second));
          return true;
        }
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("returns undefined when a sealed manifest has leftover staging", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-follow-sealed-"));
    try {
      const outDir = path.join(root, "run");
      const writer = await createDynamicsRunArtifactWriter({ outDir });
      const evidenceArtifactPath = await populate(writer);
      await writer.seal({
        evidenceArtifactPath,
        manifestFactory: (artifacts) => parseRunManifest({
          version: RUN_MANIFEST_VERSION,
          run_id: "sealed-leftover",
          created_at: new Date(0).toISOString(),
          contract_versions: {},
          artifacts
        })
      });
      await mkdir(path.join(root, `${dynamicsRunStagingPrefix(outDir)}leftover`));
      assert.equal(await findInProgressDynamicsRun(outDir), undefined);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("returns undefined when neither manifest nor staging exists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-follow-empty-"));
    try {
      assert.equal(await findInProgressDynamicsRun(path.join(root, "run")), undefined);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
