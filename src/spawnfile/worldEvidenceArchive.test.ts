import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { materializeWorldEvidenceArchive } from "./worldEvidenceArchive.js";

const block = 512;
const sha = (bytes: Uint8Array): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const octal = (value: number, length: number): Buffer =>
  Buffer.from(`${value.toString(8).padStart(length - 1, "0")}\0`, "ascii");
const header = (entry: Readonly<{ bytes?: Uint8Array; path: string }>): Buffer => {
  const directory = entry.bytes === undefined;
  const result = Buffer.alloc(block);
  result.set(Buffer.from(directory ? `${entry.path}/` : entry.path), 0);
  result.set(octal(directory ? 0o755 : 0o644, 8), 100);
  result.set(octal(0, 8), 108);
  result.set(octal(0, 8), 116);
  result.set(octal(entry.bytes?.byteLength ?? 0, 12), 124);
  result.set(octal(0, 12), 136);
  result[156] = directory ? 53 : 48;
  result.set(Buffer.from("ustar\0", "ascii"), 257);
  result.set(Buffer.from("00", "ascii"), 263);
  result.set(octal(0, 8), 329);
  result.set(octal(0, 8), 337);
  result.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of result) checksum += byte;
  result.set(Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii"), 148);
  return result;
};
const archive = (entries: readonly Readonly<{ bytes?: Uint8Array; path: string }>[]): Buffer => {
  const chunks: Buffer[] = [];
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
    chunks.push(header(entry));
    if (entry.bytes !== undefined) {
      const data = Buffer.alloc(Math.ceil(entry.bytes.byteLength / block) * block);
      data.set(entry.bytes);
      chunks.push(data);
    }
  }
  chunks.push(Buffer.alloc(block * 2));
  return Buffer.concat(chunks);
};
const fixture = async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "simfile-world-export-")));
  await chmod(root, 0o700);
  const entries = [
    { path: ".spawnfile" },
    { bytes: Buffer.from("activated"), path: ".spawnfile/world-service-activated.v1" },
    { path: "actions" },
    { bytes: Buffer.from("action"), path: "actions/accepted.json" },
    { path: "checkpoints" },
    { bytes: Buffer.from("checkpoint"), path: "checkpoints/final.json" },
    { path: "projections" },
    { bytes: Buffer.from("projection"), path: "projections/final.json" },
  ] as const;
  const bytes = archive(entries);
  const archivePath = path.join(root, "world.tar");
  await writeFile(archivePath, bytes, { mode: 0o600 });
  await chmod(archivePath, 0o600);
  const files = entries.filter((entry): entry is typeof entry & { bytes: Uint8Array } =>
    "bytes" in entry).map((entry) => ({
    bytes: entry.bytes.byteLength, path: entry.path, sha256: sha(entry.bytes),
  }));
  const evidenceIndex = {
    evidence_digest: sha(bytes), export_handle: "opaque_1111111111111111",
    files, item_count: files.length, labels: [], run_id: "run-one",
    source: { evidence_volume_handle: "opaque_2222222222222222", state: "preserved" as const },
    state: "exported" as const, version: "spawnfile.target-resource.export-index.v1" as const,
  };
  return { archivePath, bytes, destination: path.join(root, "world"), evidenceIndex };
};

test("materializes exact digest-bound canonical target evidence without external tar", async () => {
  const value = await fixture();
  await materializeWorldEvidenceArchive({
    archive_path: value.archivePath,
    destination_directory: value.destination,
    evidence_index: value.evidenceIndex,
  });
  assert.equal(await readFile(path.join(value.destination, "actions/accepted.json"), "utf8"), "action");
  assert.equal(await readFile(path.join(value.destination, "checkpoints/final.json"), "utf8"), "checkpoint");
  assert.equal((await lstat(value.destination)).mode & 0o777, 0o700);
  assert.equal((await lstat(path.join(value.destination, "actions/accepted.json"))).mode & 0o777, 0o600);
  await assert.rejects(materializeWorldEvidenceArchive({
    archive_path: value.archivePath,
    destination_directory: value.destination,
    evidence_index: value.evidenceIndex,
  }), /archive is invalid/u);
});

test("rejects changed archive bytes and changed byte-derived inventory before publication", async () => {
  const changedArchive = await fixture();
  const changed = Buffer.from(changedArchive.bytes);
  changed[block + 1] ^= 1;
  await writeFile(changedArchive.archivePath, changed, { mode: 0o600 });
  await assert.rejects(materializeWorldEvidenceArchive({
    archive_path: changedArchive.archivePath,
    destination_directory: changedArchive.destination,
    evidence_index: changedArchive.evidenceIndex,
  }), /archive is invalid/u);
  await assert.rejects(lstat(changedArchive.destination));

  const changedIndex = await fixture();
  await assert.rejects(materializeWorldEvidenceArchive({
    archive_path: changedIndex.archivePath,
    destination_directory: changedIndex.destination,
    evidence_index: {
      ...changedIndex.evidenceIndex,
      files: changedIndex.evidenceIndex.files.map((file, index) =>
        index === 0 ? { ...file, sha256: sha(Buffer.from("forged")) } : file),
    },
  }), /archive is invalid/u);
  await assert.rejects(lstat(changedIndex.destination));
});
