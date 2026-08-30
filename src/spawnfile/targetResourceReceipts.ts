import { z } from "zod";

import { assertSecretFreeComposedJson, digestComposedJson } from "../compose/json.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const handle = z.string().regex(/^opaque_[a-z0-9]{16,64}$/u);
const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
export const targetSelectedTargetSchema = z.object({
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{32}$/u), handle,
}).strict();
const label = z.object({ key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
  value: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u) }).strict();
const evidenceIndex = z.object({
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
  labels: z.array(label).max(16),
  run_id: runId,
  source: z.object({ evidence_volume_handle: handle,
    state: z.literal("preserved") }).strict(),
  state: z.literal("exported"),
  version: z.literal("spawnfile.target-resource.export-index.v1"),
}).strict().superRefine((value, context) => {
  const paths = value.files.map(({ path }) => path);
  if (value.item_count !== value.files.length || new Set(paths).size !== paths.length
    || paths.some((entry, index) => index > 0 && paths[index - 1]! >= entry)) {
    context.addIssue({ code: z.ZodIssueCode.custom,
      message: "target evidence inventory is invalid" });
  }
});

export const targetResourceReceiptSchema = z.object({
  cleanup_state: z.enum(["not_requested", "preserved", "removed", "incomplete"]).nullable(),
  descriptor_digest: digest,
  evidence_index: evidenceIndex.optional(),
  export_state: z.enum(["not_requested", "exported", "incomplete"]).nullable(),
  labels: z.array(label).max(16),
  operation: z.enum(["attach_organization", "cleanup_run", "create_world_service",
    "detach_organization", "export_evidence_volume", "revoke_secret_bindings",
    "start_world_service", "stop_world_service"]),
  operation_handle: handle, receipt_digest: digest, request_digest: digest,
  result_handle: handle.nullable(),
  resulting_revision: z.number().int().min(1).max(2_147_483_647),
  run_id: runId, selected_target: targetSelectedTargetSchema,
  version: z.literal("spawnfile.target-resource.receipt.v1"),
}).strict().superRefine((value, context) => {
  if ((value.operation === "export_evidence_volume") !== (value.evidence_index !== undefined)
    || value.evidence_index !== undefined && (value.export_state !== "exported"
      || value.result_handle !== value.evidence_index.export_handle
      || value.run_id !== value.evidence_index.run_id
      || JSON.stringify(value.labels) !== JSON.stringify(value.evidence_index.labels))) {
    context.addIssue({ code: z.ZodIssueCode.custom,
      message: "target evidence receipt is invalid" });
  }
});

export type TargetResourceReceipt = z.infer<typeof targetResourceReceiptSchema>;

export const parseTargetResourceReceipt = (raw: unknown): TargetResourceReceipt => {
  assertSecretFreeComposedJson(raw);
  const receipt = targetResourceReceiptSchema.parse(raw);
  const { receipt_digest: _digest, ...body } = receipt;
  if (receipt.receipt_digest !== digestComposedJson(
    "spawnfile.target-resource.receipt.v1", body,
  )) throw new TypeError("Spawnfile target receipt digest is invalid");
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
  if (receipt.operation !== input.operation || receipt.run_id !== input.run_id
    || receipt.run_id !== input.request.run_id
    || receipt.descriptor_digest !== input.request.descriptor_digest
    || JSON.stringify(receipt.selected_target) !== JSON.stringify(input.request.selected_target)
    || receipt.resulting_revision !== input.resulting_revision
    || receipt.request_digest !== digestComposedJson(
      "spawnfile.target-resource.request.v1", input.request,
    )) throw new TypeError("Spawnfile target operation correlation is invalid");
  return receipt;
};
