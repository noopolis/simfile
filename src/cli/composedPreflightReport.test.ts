import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertRecoverySourceDigests,
  readPreflightCompileReport,
  writePreflightCompileReport,
} from "./composedPreflightReport.js";

const report = (fingerprint: string) => ({
  compile_fingerprint: fingerprint,
  container: {
    runtime_instances: [{ engine_by_node_id: { "agent:analyst": "scripted" } }],
  },
});
const digest = (bytes: string | Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

test("recovery reads the immutable preflight report after up mutates compiled output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simfile-preflight-report-"));
  try {
    const snapshotPath = path.join(root, "preflight-report.json");
    const compiledPath = path.join(root, "compiled", "spawnfile-report.json");
    await mkdir(path.dirname(compiledPath));
    const snapshot = await writePreflightCompileReport(
      snapshotPath, report("sf1:aaaaaaaaaaaa"),
    );
    assert.equal((await stat(snapshotPath)).mode & 0o777, 0o600);

    // Models Spawnfile's legitimate bound recompile during `up`.
    await writeFile(compiledPath, JSON.stringify(report("sf1:bbbbbbbbbbbb")));
    const recovered = await readPreflightCompileReport(snapshotPath, snapshot.digest);
    assert.equal(recovered.compile_fingerprint, "sf1:aaaaaaaaaaaa");
    assert.equal(JSON.parse(await readFile(compiledPath, "utf8")).compile_fingerprint,
      "sf1:bbbbbbbbbbbb");
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("recovery fails closed on snapshot or source drift", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simfile-preflight-drift-"));
  try {
    const snapshotPath = path.join(root, "preflight-report.json");
    const snapshot = await writePreflightCompileReport(
      snapshotPath, report("sf1:aaaaaaaaaaaa"),
    );
    await writeFile(snapshotPath, JSON.stringify(report("sf1:bbbbbbbbbbbb")), {
      mode: 0o600,
    });
    await assert.rejects(readPreflightCompileReport(snapshotPath, snapshot.digest),
      /snapshot changed/u);

    const simfileSource = "simfile_version: '0.1'\nname: stable\n";
    const spawnfileSource = new TextEncoder().encode("spawnfile_version: '0.1'\n");
    assert.doesNotThrow(() => assertRecoverySourceDigests({
      expected_simfile_digest: digest(simfileSource),
      expected_spawnfile_digest: digest(spawnfileSource),
      simfile_source: simfileSource,
      spawnfile_source: spawnfileSource,
    }));
    assert.throws(() => assertRecoverySourceDigests({
      expected_simfile_digest: digest(simfileSource),
      expected_spawnfile_digest: digest(spawnfileSource),
      simfile_source: `${simfileSource}clock: { seed: hostile }\n`,
      spawnfile_source: spawnfileSource,
    }), /project source changed/u);
  } finally { await rm(root, { force: true, recursive: true }); }
});
