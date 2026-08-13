import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { z } from "zod";

import { assertSecretFreeComposedJson, digestComposedJson } from "../compose/json.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const handle = z.string().regex(/^opaque_[a-z0-9]{16,64}$/u);
const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
export const targetSelectedTargetSchema = z.object({
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{32}$/u),
  handle,
}).strict();

const targetEvidenceIndexSchema = z.object({
  evidence_digest: digest,
  export_handle: handle,
  files: z.array(z.object({
    bytes: z.number().int().min(0).max(67_108_864),
    path: z.string().max(255).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u)
      .or(z.literal(".spawnfile/world-service-activated.v1"))
      .refine((value) => !value.includes("//")
        && !value.split("/").some((part) => part === "." || part === "..")),
    sha256: digest,
  }).strict()).max(10_000),
  item_count: z.number().int().min(0).max(10_000),
  labels: z.array(z.object({
    key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
    value: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
  }).strict()).max(16),
  run_id: runId,
  source: z.object({ evidence_volume_handle: handle, state: z.literal("preserved") }).strict(),
  state: z.literal("exported"),
  version: z.literal("spawnfile.target-resource.export-index.v1"),
}).strict().superRefine((value, context) => {
  const paths = value.files.map(({ path }) => path);
  if (value.item_count !== value.files.length || new Set(paths).size !== paths.length
    || paths.some((entry, index) => index > 0 && paths[index - 1]! >= entry)) context.addIssue({
    code: z.ZodIssueCode.custom, message: "target evidence inventory is invalid",
  });
});

export const targetResourceReceiptSchema = z.object({
  cleanup_state: z.enum(["not_requested", "preserved", "removed", "incomplete"]).nullable(),
  descriptor_digest: digest,
  evidence_index: targetEvidenceIndexSchema.optional(),
  export_state: z.enum(["not_requested", "exported", "incomplete"]).nullable(),
  labels: z.array(z.object({
    key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
    value: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
  }).strict()).max(16),
  operation: z.enum([
    "attach_organization", "cleanup_run", "create_world_service", "detach_organization",
    "export_evidence_volume", "revoke_secret_bindings", "start_world_service",
    "stop_world_service",
  ]),
  operation_handle: handle,
  receipt_digest: digest,
  request_digest: digest,
  result_handle: handle.nullable(),
  resulting_revision: z.number().int().min(1).max(2_147_483_647),
  run_id: runId,
  selected_target: targetSelectedTargetSchema,
  version: z.literal("spawnfile.target-resource.receipt.v1"),
}).strict().superRefine((value, context) => {
  if ((value.operation === "export_evidence_volume") !== (value.evidence_index !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "target evidence index is invalid" });
  }
  if (value.evidence_index !== undefined && (value.export_state !== "exported"
    || value.result_handle !== value.evidence_index.export_handle
    || value.run_id !== value.evidence_index.run_id
    || JSON.stringify(value.labels) !== JSON.stringify(value.evidence_index.labels))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "target evidence receipt is invalid" });
  }
});

export type TargetResourceReceipt = z.infer<typeof targetResourceReceiptSchema>;

export const parseTargetResourceReceipt = (raw: unknown): TargetResourceReceipt => {
  assertSecretFreeComposedJson(raw);
  const receipt = targetResourceReceiptSchema.parse(raw);
  const { receipt_digest: _receiptDigest, ...body } = receipt;
  if (receipt.receipt_digest !== digestComposedJson("spawnfile.target-resource.receipt.v1", body)) {
    throw new TypeError("Spawnfile target receipt digest is invalid");
  }
  return Object.freeze(receipt);
};

export const verifyTargetResourceReceipt = (input: Readonly<{
  operation: TargetResourceReceipt["operation"];
  raw: unknown;
  request: Readonly<Record<string, unknown>>;
  resulting_revision: number;
  run_id: string;
}>): TargetResourceReceipt => {
  const receipt = parseTargetResourceReceipt(input.raw);
  const expectedTarget = input.request.selected_target;
  if (receipt.operation !== input.operation
    || receipt.run_id !== input.run_id
    || receipt.run_id !== input.request.run_id
    || receipt.descriptor_digest !== input.request.descriptor_digest
    || JSON.stringify(receipt.selected_target) !== JSON.stringify(expectedTarget)
    || receipt.resulting_revision !== input.resulting_revision
    || receipt.request_digest !== digestComposedJson(
      "spawnfile.target-resource.request.v1", input.request,
    )) throw new TypeError("Spawnfile target operation correlation is invalid");
  return receipt;
};

const readinessReceipt = z.object({
  readiness: z.unknown(),
  readiness_digest: digest,
  request_digest: digest,
  run_id: runId,
  version: z.literal("spawnfile.target-world-readiness-receipt.v1"),
}).strict();

export const verifyTargetReadinessReceipt = (input: Readonly<{
  raw: unknown;
  request: Readonly<Record<string, unknown>>;
}>): unknown => {
  assertSecretFreeComposedJson(input.raw);
  const receipt = readinessReceipt.parse(input.raw);
  if (receipt.run_id !== input.request.run_id
    || receipt.request_digest !== digestComposedJson(
      "spawnfile.target-world-readiness.request.v1", input.request,
    )
    || receipt.readiness_digest !== digestComposedJson(
      "spawnfile.target-world-readiness.document.v1", receipt.readiness,
    )) throw new TypeError("Spawnfile target readiness correlation is invalid");
  return receipt.readiness;
};

const worldClockReceipt = z.object({
  action_count: z.literal(0),
  activation_digest: digest,
  activation_receipt_digest: digest,
  clock: z.object({
    completed_tick: z.number().int().min(1).max(1_000_000_000),
    next_tick: z.number().int().min(2).max(1_000_000_001),
    state: z.literal("running"),
  }).strict(),
  observation_digest: digest,
  receipt_digest: digest,
  request_digest: digest,
  run_id: runId,
  topology_receipt_digest: digest,
  topology_request_digest: digest,
  version: z.literal("spawnfile.target-world-clock-receipt.v1"),
  world_instance_id: runId,
  world_service_handle: handle,
}).strict().superRefine((value, context) => {
  if (value.clock.next_tick !== value.clock.completed_tick + 1) context.addIssue({
    code: z.ZodIssueCode.custom, message: "world clock frontier is invalid",
  });
});

export const verifyTargetWorldClockReceipt = (input: Readonly<{
  raw: unknown;
  request: Readonly<Record<string, unknown>>;
}>): z.infer<typeof worldClockReceipt> => {
  assertSecretFreeComposedJson(input.raw);
  const receipt = worldClockReceipt.parse(input.raw);
  const expected = input.request.expected as Readonly<Record<string, unknown>>;
  const { receipt_digest: _receiptDigest, ...body } = receipt;
  const observation = {
    action_count: receipt.action_count,
    clock: receipt.clock,
    run_id: receipt.run_id,
    version: expected.document_version,
    world_instance_id: receipt.world_instance_id,
  };
  if (receipt.run_id !== input.request.run_id
    || receipt.world_service_handle !== input.request.world_service_handle
    || receipt.world_instance_id !== expected.world_instance_id
    || receipt.activation_digest !== input.request.activation_digest
    || receipt.activation_receipt_digest !== input.request.activation_receipt_digest
    || receipt.topology_receipt_digest !== input.request.topology_receipt_digest
    || receipt.topology_request_digest !== input.request.topology_request_digest
    || receipt.request_digest !== digestComposedJson(
      "spawnfile.target-world-clock.request.v1", input.request,
    )
    || receipt.observation_digest !== digestComposedJson(
      "spawnfile.target-world-clock.observation.v1", observation,
    )
    || receipt.receipt_digest !== digestComposedJson(
      "spawnfile.target-world-clock-receipt.v1", body,
    )) throw new TypeError("Spawnfile target world clock correlation is invalid");
  return receipt;
};

const publicArtifact = z.object({
  artifact_id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
  content_base64: z.string().max(Math.ceil(131_072 / 3) * 4),
  content_digest: digest,
  media_type: z.string().min(1).max(127),
  request_digest: digest,
  run_id: runId,
  size_bytes: z.number().int().min(0).max(131_072),
  version: z.literal("spawnfile.target-public-artifact-snapshot.v1"),
}).strict();

interface TargetPublicArtifactReadInput {
  artifact_id: string;
  raw: unknown;
  request: Readonly<Record<string, unknown>>;
}

/** Returns a fresh verified buffer; the caller owns and should zero it after use. */
export const readTargetPublicBytes = (
  input: Readonly<TargetPublicArtifactReadInput>,
): Buffer => {
  assertSecretFreeComposedJson(input.raw);
  const receipt = publicArtifact.parse(input.raw);
  const bytes = Buffer.from(receipt.content_base64, "base64");
  try {
    const requestedArtifact = input.request.artifact as Readonly<{
      id?: unknown;
      max_bytes?: unknown;
      media_type?: unknown;
    }> | undefined;
    if (bytes.toString("base64") !== receipt.content_base64
      || bytes.byteLength !== receipt.size_bytes
      || receipt.artifact_id !== input.artifact_id
      || receipt.artifact_id !== requestedArtifact?.id
      || receipt.run_id !== input.request.run_id
      || receipt.media_type !== requestedArtifact?.media_type
      || !Number.isSafeInteger(requestedArtifact?.max_bytes)
      || receipt.size_bytes > (requestedArtifact?.max_bytes as number)
      || receipt.content_digest !== `sha256:${createHash("sha256").update(bytes).digest("hex")}`
      || receipt.request_digest !== digestComposedJson(
        "spawnfile.target-public-artifact-snapshot.request.v1", input.request,
      )) throw new TypeError("Spawnfile public artifact correlation is invalid");
    return bytes;
  } catch (error) {
    bytes.fill(0);
    throw error;
  }
};

export const readTargetPublicJson = (
  input: Readonly<TargetPublicArtifactReadInput>,
): unknown => {
  const bytes = readTargetPublicBytes(input);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } finally {
    bytes.fill(0);
  }
};
