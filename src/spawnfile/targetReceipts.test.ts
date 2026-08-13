import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import test from "node:test";

import { digestComposedJson } from "../compose/json.js";
import {
  parseTargetResourceReceipt,
  readTargetPublicBytes,
  readTargetPublicJson,
  verifyTargetWorldClockReceipt,
} from "./targetReceipts.js";

const d = (value: string): `sha256:${string}` =>
  `sha256:${value.repeat(64).slice(0, 64)}`;
const request = {
  activation_digest: d("1"), activation_receipt_digest: d("2"), descriptor_digest: d("3"),
  endpoint: { internal_port: 4_070, path: "/v1/world/clock" },
  expected: { document_version: "simfile.world-sidecar-clock.v1", world_instance_id: "world-one" },
  run_id: "run-one", selected_target: { fingerprint: `sha256:${"4".repeat(32)}`, handle: "opaque_1111111111111111" },
  topology_receipt_digest: d("5"), topology_request_digest: d("6"),
  version: "spawnfile.target-world-clock.request.v1", world_service_handle: "opaque_2222222222222222",
} as const;
const receipt = (clock = { completed_tick: 1, next_tick: 2, state: "running" as const }) => {
  const observation = { action_count: 0, clock, run_id: request.run_id,
    version: request.expected.document_version, world_instance_id: request.expected.world_instance_id };
  const body = {
    action_count: 0, activation_digest: request.activation_digest,
    activation_receipt_digest: request.activation_receipt_digest, clock,
    observation_digest: digestComposedJson("spawnfile.target-world-clock.observation.v1", observation),
    request_digest: digestComposedJson("spawnfile.target-world-clock.request.v1", request),
    run_id: request.run_id, topology_receipt_digest: request.topology_receipt_digest,
    topology_request_digest: request.topology_request_digest,
    version: "spawnfile.target-world-clock-receipt.v1",
    world_instance_id: request.expected.world_instance_id,
    world_service_handle: request.world_service_handle,
  } as const;
  return { ...body, receipt_digest: digestComposedJson("spawnfile.target-world-clock-receipt.v1", body) };
};

test("independent world-clock wire verification binds real progress to every authority", () => {
  assert.deepEqual(verifyTargetWorldClockReceipt({ raw: receipt(), request }).clock,
    { completed_tick: 1, next_tick: 2, state: "running" });
  assert.equal(verifyTargetWorldClockReceipt({
    raw: receipt({ completed_tick: 7, next_tick: 8, state: "running" }), request,
  }).clock.completed_tick, 7);
  for (const forged of [
    receipt({ completed_tick: 0, next_tick: 1, state: "running" }),
    { ...receipt(), activation_digest: d("9") },
    { ...receipt(), topology_receipt_digest: d("9") },
    { ...receipt(), world_service_handle: "opaque_9999999999999999" },
    { ...receipt(), action_count: 1 },
  ]) assert.throws(() => verifyTargetWorldClockReceipt({ raw: forged, request }));
});

test("target evidence wire admits only the exact Spawnfile activation marker exception", () => {
  const exportHandle = "opaque_3333333333333333";
  const body = {
    cleanup_state: "not_requested" as const, descriptor_digest: d("a"),
    evidence_index: {
      evidence_digest: d("b"), export_handle: exportHandle,
      files: [{ bytes: 1, path: ".spawnfile/world-service-activated.v1", sha256: d("c") }],
      item_count: 1, labels: [], run_id: "run-one",
      source: { evidence_volume_handle: "opaque_4444444444444444", state: "preserved" as const },
      state: "exported" as const, version: "spawnfile.target-resource.export-index.v1" as const,
    },
    export_state: "exported" as const, labels: [], operation: "export_evidence_volume" as const,
    operation_handle: "opaque_5555555555555555", request_digest: d("d"),
    result_handle: exportHandle, resulting_revision: 9, run_id: "run-one",
    selected_target: { fingerprint: `sha256:${"6".repeat(32)}`, handle: "opaque_7777777777777777" },
    version: "spawnfile.target-resource.receipt.v1" as const,
  };
  const receipt = { ...body,
    receipt_digest: digestComposedJson("spawnfile.target-resource.receipt.v1", body) };
  assert.equal(parseTargetResourceReceipt(receipt).evidence_index?.files[0]?.path,
    ".spawnfile/world-service-activated.v1");
  const forged = {
    ...receipt,
    evidence_index: { ...receipt.evidence_index,
      files: [{ ...receipt.evidence_index.files[0]!, path: ".spawnfile/other" }] },
  };
  assert.throws(() => parseTargetResourceReceipt(forged));
});

const publicArtifactRequest = {
  artifact: {
    id: "viewer_trace",
    max_bytes: 4_096,
    media_type: "application/octet-stream",
    path: "/tmp/spawnfile-public/viewer-trace.bin",
  },
  descriptor_digest: d("7"),
  run_id: "run-public-view",
  selected_target: {
    fingerprint: `sha256:${"8".repeat(32)}`,
    handle: "opaque_8888888888888888",
  },
  version: "spawnfile.target-public-artifact-snapshot.request.v1",
  world_service_handle: "opaque_9999999999999999",
} as const;

const publicArtifactReceipt = (
  content: Uint8Array,
  requestValue: Readonly<Record<string, unknown>> = publicArtifactRequest,
) => ({
  artifact_id: "viewer_trace",
  content_base64: Buffer.from(content).toString("base64"),
  content_digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
  media_type: (requestValue.artifact as { media_type: string }).media_type,
  request_digest: digestComposedJson(
    "spawnfile.target-public-artifact-snapshot.request.v1",
    requestValue,
  ),
  run_id: requestValue.run_id,
  size_bytes: content.byteLength,
  version: "spawnfile.target-public-artifact-snapshot.v1",
});

test("public-artifact byte reader returns only exactly correlated verified bytes", () => {
  const content = Buffer.from([0x00, 0xff, 0x41, 0x7f]);
  const raw = publicArtifactReceipt(content);
  const bytes = readTargetPublicBytes({
    artifact_id: "viewer_trace",
    raw,
    request: publicArtifactRequest,
  });
  try {
    assert.deepEqual(bytes, content);
    assert.notEqual(bytes, content);
  } finally {
    bytes.fill(0);
  }

  const wrongRequest = {
    ...publicArtifactRequest,
    descriptor_digest: d("9"),
  };
  for (const forged of [
    { ...raw, content_digest: d("a") },
    { ...raw, size_bytes: raw.size_bytes + 1 },
    { ...raw, artifact_id: "other_artifact" },
    { ...raw, media_type: "application/json" },
    { ...raw, run_id: "other-run" },
    { ...raw, request_digest: d("b") },
  ]) {
    assert.throws(() => readTargetPublicBytes({
      artifact_id: "viewer_trace",
      raw: forged,
      request: publicArtifactRequest,
    }), /correlation is invalid/u);
  }
  assert.throws(() => readTargetPublicBytes({
    artifact_id: "viewer_trace",
    raw,
    request: wrongRequest,
  }), /correlation is invalid/u);
  assert.throws(() => readTargetPublicBytes({
    artifact_id: "other_artifact",
    raw,
    request: publicArtifactRequest,
  }), /correlation is invalid/u);
  assert.throws(() => readTargetPublicBytes({
    artifact_id: "viewer_trace",
    raw,
    request: {
      ...publicArtifactRequest,
      artifact: { ...publicArtifactRequest.artifact, max_bytes: content.byteLength - 1 },
    },
  }), /correlation is invalid/u);
});

test("public JSON reader delegates verification and zeroes decoded bytes after parsing", () => {
  const requestValue = {
    ...publicArtifactRequest,
    artifact: { ...publicArtifactRequest.artifact, media_type: "application/json" },
  };
  const content = Buffer.from("{\"tick\":7}\n", "utf8");
  const raw = publicArtifactReceipt(content, requestValue);
  const originalFill = Buffer.prototype.fill;
  const zeroed: Buffer[] = [];
  Buffer.prototype.fill = function (this: Buffer, ...args: unknown[]): Buffer {
    const result = Reflect.apply(originalFill, this, args) as Buffer;
    if (args[0] === 0) zeroed.push(this);
    return result;
  } as unknown as typeof Buffer.prototype.fill;
  try {
    assert.deepEqual(readTargetPublicJson({
      artifact_id: "viewer_trace",
      raw,
      request: requestValue,
    }), { tick: 7 });
  } finally {
    Buffer.prototype.fill = originalFill;
  }
  assert.equal(zeroed.some((bytes) =>
    bytes.byteLength === content.byteLength && bytes.every((value) => value === 0)), true);
});
