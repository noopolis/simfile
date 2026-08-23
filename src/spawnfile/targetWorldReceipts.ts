import { z } from "zod";

import { assertSecretFreeComposedJson, digestComposedJson } from "../compose/json.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const handle = z.string().regex(/^opaque_[a-z0-9]{16,64}$/u);
const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const readinessReceipt = z.object({ readiness: z.unknown(), readiness_digest: digest,
  request_digest: digest, run_id: runId,
  version: z.literal("spawnfile.target-world-readiness-receipt.v1") }).strict();

export const verifyTargetReadinessReceipt = (input: Readonly<{
  raw: unknown;
  request: Readonly<Record<string, unknown>>;
}>): unknown => {
  assertSecretFreeComposedJson(input.raw);
  const receipt = readinessReceipt.parse(input.raw);
  if (receipt.run_id !== input.request.run_id
    || receipt.request_digest !== digestComposedJson(
      "spawnfile.target-world-readiness.request.v1", input.request,
    ) || receipt.readiness_digest !== digestComposedJson(
      "spawnfile.target-world-readiness.document.v1", receipt.readiness,
    )) throw new TypeError("Spawnfile target readiness correlation is invalid");
  return receipt.readiness;
};

const worldClockReceipt = z.object({
  action_count: z.literal(0), activation_digest: digest,
  activation_receipt_digest: digest,
  clock: z.object({ completed_tick: z.number().int().min(1).max(1_000_000_000),
    next_tick: z.number().int().min(2).max(1_000_000_001),
    state: z.literal("running") }).strict(),
  observation_digest: digest, receipt_digest: digest, request_digest: digest,
  run_id: runId, topology_receipt_digest: digest, topology_request_digest: digest,
  version: z.literal("spawnfile.target-world-clock-receipt.v1"),
  world_instance_id: runId, world_service_handle: handle,
}).strict().superRefine((value, context) => {
  if (value.clock.next_tick !== value.clock.completed_tick + 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "world clock frontier is invalid" });
  }
});

export const verifyTargetWorldClockReceipt = (input: Readonly<{
  raw: unknown;
  request: Readonly<Record<string, unknown>>;
}>): z.infer<typeof worldClockReceipt> => {
  assertSecretFreeComposedJson(input.raw);
  const receipt = worldClockReceipt.parse(input.raw);
  const expected = input.request.expected as Readonly<Record<string, unknown>>;
  const { receipt_digest: _digest, ...body } = receipt;
  const observation = { action_count: receipt.action_count, clock: receipt.clock,
    run_id: receipt.run_id, version: expected.document_version,
    world_instance_id: receipt.world_instance_id };
  if (receipt.run_id !== input.request.run_id
    || receipt.world_service_handle !== input.request.world_service_handle
    || receipt.world_instance_id !== expected.world_instance_id
    || receipt.activation_digest !== input.request.activation_digest
    || receipt.activation_receipt_digest !== input.request.activation_receipt_digest
    || receipt.topology_receipt_digest !== input.request.topology_receipt_digest
    || receipt.topology_request_digest !== input.request.topology_request_digest
    || receipt.request_digest !== digestComposedJson(
      "spawnfile.target-world-clock.request.v1", input.request,
    ) || receipt.observation_digest !== digestComposedJson(
      "spawnfile.target-world-clock.observation.v1", observation,
    ) || receipt.receipt_digest !== digestComposedJson(
      "spawnfile.target-world-clock-receipt.v1", body,
    )) throw new TypeError("Spawnfile target world clock correlation is invalid");
  return receipt;
};
