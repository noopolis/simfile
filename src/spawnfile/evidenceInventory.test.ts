import assert from "node:assert/strict";
import test from "node:test";

import { digestComposedJson } from "../compose/json.js";
import { worldInventoryFromTargetExport } from "./evidenceInventory.js";
import { parseTargetResourceReceipt } from "./targetReceipts.js";

const d = (value: string): `sha256:${string}` => `sha256:${value.repeat(64).slice(0, 64)}`;
const volume = "opaque_1111111111111111";
const raw = (files = [
  { bytes: 1, path: "actions/log.jsonl", sha256: d("1") },
  { bytes: 2, path: "checkpoints/final.json", sha256: d("2") },
  { bytes: 3, path: "projections/world.json", sha256: d("3") },
  { bytes: 4, path: "runtime-child-outcome.json", sha256: d("8") },
  { bytes: 5, path: "runtime-startup.json", sha256: d("9") },
  { bytes: 6, path: "world-sidecar.json", sha256: d("a") },
]) => {
  const index = {
    evidence_digest: d("4"), export_handle: "opaque_2222222222222222",
    files, item_count: files.length, labels: [], run_id: "run-one",
    source: { evidence_volume_handle: volume, state: "preserved" },
    state: "exported", version: "spawnfile.target-resource.export-index.v1",
  } as const;
  const body = {
    cleanup_state: "not_requested", descriptor_digest: d("5"), evidence_index: index,
    export_state: "exported", labels: [], operation: "export_evidence_volume",
    operation_handle: "opaque_3333333333333333", request_digest: d("6"),
    result_handle: index.export_handle, resulting_revision: 9, run_id: index.run_id,
    selected_target: { fingerprint: `sha256:${"7".repeat(32)}`, handle: "opaque_4444444444444444" },
    version: "spawnfile.target-resource.receipt.v1",
  } as const;
  return { ...body, receipt_digest: digestComposedJson("spawnfile.target-resource.receipt.v1", body) };
};

test("B14 inventory is exactly the verified Spawnfile byte inventory", () => {
  const receipt = parseTargetResourceReceipt(raw());
  assert.deepEqual(worldInventoryFromTargetExport(receipt, volume).map(
    ({ authority, bytes, path, sha256 }) => ({ authority, bytes, path, sha256 }),
  ), [
    { authority: "actions", bytes: 1, path: "actions/log.jsonl", sha256: d("1") },
    { authority: "checkpoints", bytes: 2, path: "checkpoints/final.json", sha256: d("2") },
    { authority: "projections", bytes: 3, path: "projections/world.json", sha256: d("3") },
    { authority: "projections", bytes: 4, path: "runtime-child-outcome.json", sha256: d("8") },
    { authority: "projections", bytes: 5, path: "runtime-startup.json", sha256: d("9") },
    { authority: "projections", bytes: 6, path: "world-sidecar.json", sha256: d("a") },
  ]);
});

test("B14 rejects missing, extra, tampered, and mismatched-source export indexes", () => {
  const valid = raw();
  for (const candidate of [
    raw(valid.evidence_index.files.slice(1)),
    raw([...valid.evidence_index.files, { bytes: 1, path: "foreign/data", sha256: d("8") }]),
    { ...valid, evidence_index: { ...valid.evidence_index, item_count: 99 } },
  ]) assert.throws(() => worldInventoryFromTargetExport(parseTargetResourceReceipt(candidate), volume));
  assert.throws(() => worldInventoryFromTargetExport(parseTargetResourceReceipt(valid),
    "opaque_9999999999999999"));
});
