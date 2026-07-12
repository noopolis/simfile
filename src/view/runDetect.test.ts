import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { isObserveRunDir } from "./runDetect.js";

const GOLDEN_FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "observe",
  "office-sim-golden"
);

describe("isObserveRunDir", () => {
  it("recognizes the golden compose-and-observe fixture", async () => {
    assert.equal(await isObserveRunDir(GOLDEN_FIXTURE_DIR), true);
  });

  it("rejects a directory with no manifest.json or transcript", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "simfile-view-not-run-"));
    assert.equal(await isObserveRunDir(dir), false);
  });

  it("rejects a world replay directory (manifest.yaml, no run-manifest.v1)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "simfile-view-world-"));
    await writeFile(path.join(dir, "manifest.yaml"), "run_id: run-x\n", "utf8");
    assert.equal(await isObserveRunDir(dir), false);
  });

  it("rejects a manifest.json that is not simfile.run-manifest.v1", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "simfile-view-wrong-version-"));
    await mkdir(path.join(dir, "raw", "moltnet"), { recursive: true });
    await writeFile(path.join(dir, "raw", "moltnet", "transcript.json"), "{}", "utf8");
    await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ version: "other.v1" }), "utf8");
    assert.equal(await isObserveRunDir(dir), false);
  });

  it("recognizes the multi-network jungian golden (per-network transcript subdirs, no flat transcript)", async () => {
    const jungianGolden = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "fixtures",
      "observe",
      "jungian-daimon-org-golden"
    );
    assert.equal(await isObserveRunDir(jungianGolden), true);
  });

  it("recognizes a run whose only transcript is under a per-network subdir", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "simfile-view-multi-net-"));
    await mkdir(path.join(dir, "raw", "moltnet", "inner_net"), { recursive: true });
    await writeFile(path.join(dir, "raw", "moltnet", "inner_net", "transcript.json"), "{}", "utf8");
    await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ version: "simfile.run-manifest.v1" }), "utf8");
    assert.equal(await isObserveRunDir(dir), true);
  });
});
