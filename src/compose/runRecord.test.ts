import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { verifyManifestArtifacts } from "../observe/artifacts.js";
import { findInProgressDynamicsRun } from "../view/runFollowLocator.js";
import { COMPOSED_ARTIFACT_ROLES, createComposedRunRecord } from "./runRecord.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(`${value}\n`);
const create = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "simfile-composed-record-"));
  const out = path.join(root, "run-one");
  const record = await createComposedRunRecord({
    identity: {
      contract_versions: {}, created_at: "2026-08-07T12:00:00.000Z",
      run_id: "run-one", spawnfile: { fingerprint: "sf1:test" },
      world: { terminal_tick: 40 },
    }, out_dir: out,
  });
  return { out, record };
};
const complete = async (record: Awaited<ReturnType<typeof create>>["record"]) => {
  for (const [index, role] of COMPOSED_ARTIFACT_ROLES.entries()) {
    const artifactPath = role === "world-frame" ? "raw/frames.jsonl"
      : `evidence/${role}.json`;
    await record.writeArtifact({ bytes: bytes(`${role}-${index}`), path: artifactPath, role });
  }
};

describe("composed run record", () => {
  it("atomically promotes one complete exact-hash inventory", async () => {
    const { out, record } = await create();
    await complete(record);
    assert.equal(path.basename((await findInProgressDynamicsRun(out))!),
      path.basename(record.staging_dir));
    const sealed = await record.seal();
    assert.equal(sealed.out_dir, out);
    assert.equal(await findInProgressDynamicsRun(out), undefined);
    const checks = await verifyManifestArtifacts(out, sealed.manifest.artifacts);
    assert.equal(checks.length, COMPOSED_ARTIFACT_ROLES.length + 1);
    assert.equal(checks.every(({ ok }) => ok), true);
    await stat(path.join(out, "manifest.json"));
  });

  it("refuses missing inventory roles and changed bytes", async () => {
    const first = await create();
    await first.record.writeArtifact({ bytes: bytes("identity"),
      path: "identity.json", role: "identity" });
    await assert.rejects(first.record.seal(), /inventory is incomplete/u);
    await first.record.abort();

    const second = await create();
    await complete(second.record);
    await writeFile(path.join(second.record.staging_dir, "evidence/identity.json"), "tampered\n");
    await assert.rejects(second.record.seal(), /changed before seal/u);
    await assert.rejects(readFile(path.join(second.out, "manifest.json")));
    await second.record.abort();
  });

  it("rejects traversal, duplicates, reserved files, and output reuse", async () => {
    const { out, record } = await create();
    for (const artifactPath of ["../escape", "/absolute", "manifest.json", "inventory.json"]) {
      await assert.rejects(record.writeArtifact({ bytes: bytes("x"),
        path: artifactPath, role: "identity" }), /path is invalid/u);
    }
    await record.writeArtifact({ bytes: bytes("x"), path: "identity.json", role: "identity" });
    await assert.rejects(record.writeArtifact({ bytes: bytes("x"),
      path: "identity.json", role: "identity" }), /declaration is invalid/u);
    await assert.rejects(createComposedRunRecord({ identity: {
      contract_versions: {}, created_at: "2026-08-07T12:00:00.000Z", run_id: "run-one",
    }, out_dir: out }));
    await record.abort();
  });

  it("adopts a group only after every artifact is durable", async () => {
    const { record } = await create();
    const collision = path.join(record.staging_dir, "evidence", "collision.json");
    await mkdir(path.dirname(collision), { recursive: true });
    await writeFile(collision, "occupied\n", { flag: "wx" });
    await assert.rejects(record.writeArtifacts([
      { bytes: bytes("first"), path: "evidence/first.json", role: "provenance" },
      { bytes: bytes("second"), path: "evidence/collision.json", role: "presentation" },
    ]));
    await assert.rejects(readFile(path.join(record.staging_dir, "evidence", "first.json")));
    assert.equal(await readFile(collision, "utf8"), "occupied\n");
    await record.writeArtifact({ bytes: bytes("first"),
      path: "evidence/first.json", role: "provenance" });
    await record.abort();
  });

  it("removes the current artifact when a durable write fails after creation", async () => {
    const { record } = await create();
    const buffer = new ArrayBuffer(16);
    const detached = new Uint8Array(buffer);
    detached.set(new TextEncoder().encode("second\n"));
    const pending = record.writeArtifacts([
      { bytes: bytes("first"), path: "evidence/first.json", role: "provenance" },
      { bytes: detached, path: "evidence/second.json", role: "presentation" },
    ]);
    structuredClone(buffer, { transfer: [buffer] });
    await assert.rejects(pending, TypeError);
    await assert.rejects(readFile(path.join(record.staging_dir, "evidence/first.json")),
      /ENOENT/u);
    await assert.rejects(readFile(path.join(record.staging_dir, "evidence/second.json")),
      /ENOENT/u);
    await record.writeArtifacts([
      { bytes: bytes("first"), path: "evidence/first.json", role: "provenance" },
      { bytes: bytes("second"), path: "evidence/second.json", role: "presentation" },
    ]);
    await record.abort();
  });
});
