import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseSpawnfileDownReceipt,
  parseSpawnfileExportResult,
  parseSpawnfileUpReceipt
} from "./receipts.js";

describe("parseSpawnfileUpReceipt", () => {
  const validReceipt = {
    version: "spawnfile.up-receipt.v1",
    run_id: "run-abc123",
    fingerprint: "sf1:deadbeef",
    deployment: { name: "simfile-office-composed", container_ids: ["c1"] },
    readiness: { state: "running", moltnet_base_url: "http://127.0.0.1:19941" },
    compiled_schedule: [],
    engines: [
      { agent: "agent:eleanor", engine: "scripted" },
      { agent: "agent:sam", engine: "scripted" }
    ]
  };

  it("parses a real up-receipt shape, ignoring unmodeled fields like compiled_schedule", () => {
    const parsed = parseSpawnfileUpReceipt(validReceipt);
    assert.equal(parsed.run_id, "run-abc123");
    assert.equal(parsed.readiness.moltnet_base_url, "http://127.0.0.1:19941");
    assert.deepEqual(parsed.engines, validReceipt.engines);
  });

  it("tolerates a receipt with no engines field (pre-Piece-5 shape)", () => {
    const { engines, ...withoutEngines } = validReceipt;
    void engines;
    const parsed = parseSpawnfileUpReceipt(withoutEngines);
    assert.equal(parsed.engines, undefined);
  });

  it("throws with a readable message for a malformed receipt", () => {
    assert.throws(() => parseSpawnfileUpReceipt({ version: "spawnfile.up-receipt.v1" }), /invalid spawnfile up-receipt/);
  });

  it("rejects non-object input", () => {
    assert.throws(() => parseSpawnfileUpReceipt("not json"));
    assert.throws(() => parseSpawnfileUpReceipt(null));
  });
});

describe("parseSpawnfileExportResult", () => {
  const validResult = {
    deployment: "simfile-office-composed",
    failed_files: [],
    missing_optional_files: [],
    index_path: "/tmp/run/spawnfile/export-index.json",
    index: {
      version: "spawnfile.export-index.v1",
      run_id: "run-abc123",
      deployment: "simfile-office-composed",
      exported_at: "2026-07-11T00:00:00.000Z",
      files: [
        {
          path: "raw/moltnet/causal.jsonl",
          sha256: "a".repeat(64),
          bytes: 100,
          source: { kind: "volume", ref: "some-volume:/causal.jsonl" }
        }
      ]
    }
  };

  it("parses a real export result and its nested export-index", () => {
    const parsed = parseSpawnfileExportResult(validResult);
    assert.equal(parsed.index.files.length, 1);
    assert.equal(parsed.index.files[0]?.path, "raw/moltnet/causal.jsonl");
  });

  it("rejects a file entry with a malformed sha256", () => {
    assert.throws(() =>
      parseSpawnfileExportResult({
        ...validResult,
        index: { ...validResult.index, files: [{ path: "x", sha256: "not-hex" }] }
      })
    );
  });
});

describe("parseSpawnfileDownReceipt", () => {
  it("parses a real down-receipt shape", () => {
    const parsed = parseSpawnfileDownReceipt({
      version: "spawnfile.down-receipt.v1",
      deployment: "simfile-office-composed",
      units_stopped: ["simfile-office-composed-container"],
      retained_volumes: [],
      errors: []
    });
    assert.deepEqual(parsed.units_stopped, ["simfile-office-composed-container"]);
    assert.deepEqual(parsed.errors, []);
  });

  it("defaults array fields when absent", () => {
    const parsed = parseSpawnfileDownReceipt({
      version: "spawnfile.down-receipt.v1",
      deployment: "simfile-office-composed"
    });
    assert.deepEqual(parsed.units_stopped, []);
    assert.deepEqual(parsed.retained_volumes, []);
    assert.deepEqual(parsed.errors, []);
  });
});
