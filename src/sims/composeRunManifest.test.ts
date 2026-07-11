import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseRunManifest } from "../observe/manifest.js";

import { composeRunManifest, sha256HexOfBuffer } from "./composeRunManifest.js";

describe("composeRunManifest", () => {
  const baseInput = {
    runId: "run-composed-abc123",
    createdAt: "2026-07-11T00:00:00.000Z",
    engine: "scripted",
    world: { network_id: "office_lab", room_id: "office-room", members: ["eleanor", "sam"] },
    exportedArtifacts: [
      { path: "raw/moltnet/causal.jsonl", sha256: "a".repeat(64) },
      { path: "raw/daimon/eleanor/causal.jsonl", sha256: "b".repeat(64) }
    ]
  };

  it("produces a manifest that validates against simfile.run-manifest.v1", () => {
    const manifest = composeRunManifest(baseInput);
    const parsed = parseRunManifest(manifest);
    assert.equal(parsed.run_id, "run-composed-abc123");
    assert.equal(parsed.engine, "scripted");
  });

  it("stamps the same fixed contract_versions the golden fixture uses", () => {
    const manifest = composeRunManifest(baseInput);
    assert.deepEqual(manifest.contract_versions, {
      "causal-event.v1": "noopolis.causal-event.v1",
      "simfile.observe.v1": "simfile.observe.v1",
      "simfile.run-manifest.v1": "simfile.run-manifest.v1"
    });
  });

  it("folds exported artifacts and extra artifacts together, sorted by path", () => {
    const manifest = composeRunManifest({
      ...baseInput,
      extraArtifacts: [{ path: "raw/moltnet/transcript.json", sha256: "c".repeat(64) }]
    });
    assert.deepEqual(
      manifest.artifacts.map((artifact) => artifact.path),
      ["raw/daimon/eleanor/causal.jsonl", "raw/moltnet/causal.jsonl", "raw/moltnet/transcript.json"]
    );
  });

  it("is deterministic: two calls with identical input produce byte-identical output", () => {
    const first = composeRunManifest(baseInput);
    const second = composeRunManifest(baseInput);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });

  it("omits the spawnfile block when no fingerprint is given, includes it when one is", () => {
    const withoutFingerprint = composeRunManifest(baseInput);
    assert.equal(withoutFingerprint.spawnfile, undefined);

    const withFingerprint = composeRunManifest({ ...baseInput, fingerprint: "sf1:deadbeef" });
    assert.deepEqual(withFingerprint.spawnfile, { fingerprint: "sf1:deadbeef" });
  });

  it("carries the world shape through untouched", () => {
    const manifest = composeRunManifest(baseInput);
    assert.deepEqual(manifest.world, {
      network_id: "office_lab",
      room_id: "office-room",
      members: ["eleanor", "sam"]
    });
  });
});

describe("sha256HexOfBuffer", () => {
  it("matches the well-known sha256 of an empty buffer", () => {
    assert.equal(
      sha256HexOfBuffer(Buffer.from("", "utf8")),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("is deterministic for the same content", () => {
    const buffer = Buffer.from("hello composed run", "utf8");
    assert.equal(sha256HexOfBuffer(buffer), sha256HexOfBuffer(Buffer.from("hello composed run", "utf8")));
  });
});
