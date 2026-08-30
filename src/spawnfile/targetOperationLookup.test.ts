import assert from "node:assert/strict";
import test from "node:test";

import { digestComposedJson } from "../compose/json.js";
import { parseTargetOperationLookup } from "./targetOperationLookup.js";

const request = {
  descriptor_digest: `sha256:${"1".repeat(64)}`,
  expected_revision: 0,
  idempotency_key: "idem_aaaaaaaaaaaaaaaa",
  operation: "create_data_network",
  run_id: "run-one",
  selected_target: {
    fingerprint: `sha256:${"2".repeat(32)}`,
    handle: "opaque_bbbbbbbbbbbbbbbb",
  },
  version: "spawnfile.target-resource.request.v1",
} as const;
const requestDigest = digestComposedJson(
  "spawnfile.target-resource.request.v1", request,
);
const common = { idempotency_key: request.idempotency_key,
  operation: request.operation, request_digest: requestDigest,
  version: "spawnfile.target-resource.operation-lookup.v1" } as const;

test("target lookup preserves typed pending and validates completed correlation", () => {
  const pending = parseTargetOperationLookup({ ...common,
    operation_handle: "opaque_cccccccccccccccc", status: "pending" }, request);
  assert.equal(pending.status, "pending");
  assert.equal(pending.operation_handle, "opaque_cccccccccccccccc");
  const receipt = { operation: request.operation,
    operation_handle: "opaque_cccccccccccccccc", request_digest: requestDigest };
  assert.deepEqual(parseTargetOperationLookup({ ...common,
    operation_handle: receipt.operation_handle, receipt, status: "completed" }, request), {
    operation_handle: receipt.operation_handle, request_digest: requestDigest,
    status: "completed", target_receipt: receipt,
  });
  assert.throws(() => parseTargetOperationLookup({ ...common,
    operation_handle: receipt.operation_handle,
    receipt: { ...receipt, operation: "cleanup_run" }, status: "completed" }, request),
  /uncorrelated/u);
});

test("target lookup rejects drift and contradictory wire shapes", () => {
  assert.deepEqual(parseTargetOperationLookup({ ...common,
    status: "not_applied" }, request).status, "not_applied");
  for (const forged of [
    { ...common, idempotency_key: "idem_dddddddddddddddd", status: "not_applied" },
    { ...common, operation: "cleanup_run", status: "not_applied" },
    { ...common, operation_handle: "opaque_cccccccccccccccc",
      status: "not_applied" },
  ]) assert.throws(() => parseTargetOperationLookup(forged, request));
});
