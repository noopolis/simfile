import { z } from "zod";

import {
  assertSecretFreeComposedJson,
  canonicalComposedJson,
  digestComposedJson,
} from "../compose/json.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const handle = z.string().regex(/^opaque_[a-z0-9]{16,64}$/u);
const base = {
  idempotency_key: z.string().regex(/^idem_[a-z0-9]{16,64}$/u),
  operation: z.string().regex(/^[a-z][a-z_]{1,63}$/u),
  request_digest: digest,
  version: z.literal("spawnfile.target-resource.operation-lookup.v1"),
};
const lookup = z.discriminatedUnion("status", [
  z.object({ ...base, status: z.literal("not_applied") }).strict(),
  z.object({ ...base, operation_handle: handle,
    status: z.literal("pending") }).strict(),
  z.object({ ...base, operation_handle: handle,
    receipt: z.record(z.string(), z.unknown()),
    status: z.literal("completed") }).strict(),
]);

export interface TargetOperationLookup {
  readonly operation_handle?: string;
  readonly request_digest: `sha256:${string}`;
  readonly status: "completed" | "not_applied" | "pending";
  readonly target_receipt?: Readonly<Record<string, unknown>>;
}

/** Independently verifies Spawnfile's exact lookup correlation envelope. */
export const parseTargetOperationLookup = (
  raw: unknown,
  request: Readonly<Record<string, unknown>>,
): TargetOperationLookup => {
  assertSecretFreeComposedJson(raw);
  const value = lookup.parse(raw);
  const expected = digestComposedJson("spawnfile.target-resource.request.v1", request);
  if (value.request_digest !== expected
    || value.idempotency_key !== request.idempotency_key
    || value.operation !== request.operation) {
    throw new TypeError("target operation lookup correlation is invalid");
  }
  if (value.status === "completed") {
    const receipt = value.receipt;
    if (receipt.request_digest !== value.request_digest
      || receipt.operation !== value.operation
      || receipt.operation_handle !== value.operation_handle) {
      throw new TypeError("target operation lookup receipt is uncorrelated");
    }
    return Object.freeze({ operation_handle: value.operation_handle,
      request_digest: value.request_digest, status: value.status,
      target_receipt: Object.freeze(JSON.parse(
        canonicalComposedJson(receipt),
      ) as Record<string, unknown>) });
  }
  return Object.freeze({
    ...(value.status === "pending" ? { operation_handle: value.operation_handle } : {}),
    request_digest: value.request_digest,
    status: value.status,
  });
};
