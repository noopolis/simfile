import { z } from "zod";

import {
  assertSecretFreeComposedJson,
  digestComposedJson,
} from "../compose/json.js";

export const SPAWNFILE_COMPOSED_PREPARATION_REQUEST_VERSION =
  "spawnfile.composed-preparation.request.v1" as const;
export const SPAWNFILE_COMPOSED_PREPARATION_RECEIPT_VERSION =
  "spawnfile.composed-preparation.receipt.v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const opaqueHandle = z.string().regex(/^opaque_[a-z0-9]{16,64}$/u);
const selectedTarget = z.object({
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{32}$/u),
  handle: opaqueHandle,
  version: z.literal("spawnfile.target-resource.selected-target.v1"),
}).passthrough();

export const spawnfileComposedPreparationRequestSchema = z.object({
  auth_profile: identifier,
  descriptor_digest: digest,
  idempotency_key: z.string().regex(/^idem_[a-z0-9]{16,64}$/u),
  organization: z.object({
    artifact_digest: digest,
    world_bindings_digest: digest,
  }).strict(),
  run_id: runId,
  secret_bindings: z.array(z.object({
    name: identifier,
    scope: identifier,
    source_handle: opaqueHandle,
  }).strict()).min(1).max(32),
  target_selector: identifier,
  version: z.literal(SPAWNFILE_COMPOSED_PREPARATION_REQUEST_VERSION),
  world: z.object({
    artifact_manifest_digest: digest,
    bundle_digest: digest,
  }).strict(),
}).strict();

const mutationReceipt = z.object({
  cleanup_state: z.enum(["not_requested", "preserved", "removed", "incomplete"]).nullable(),
  descriptor_digest: digest,
  export_state: z.enum(["not_requested", "exported", "incomplete"]).nullable(),
  labels: z.array(z.object({ key: identifier, value: identifier }).passthrough()).max(16),
  operation: z.enum([
    "resolve_world_artifact", "prepare_secret_bindings",
    "create_data_network", "create_evidence_volume",
  ]),
  operation_handle: opaqueHandle,
  receipt_digest: digest,
  request_digest: digest,
  result_handle: opaqueHandle,
  resulting_revision: z.number().int().min(1).max(4),
  run_id: runId,
  selected_target: selectedTarget.omit({ version: true }).passthrough(),
  version: z.literal("spawnfile.target-resource.receipt.v1"),
}).passthrough();

export const spawnfileComposedPreparationReceiptSchema = z.object({
  auth_profile: identifier,
  descriptor_digest: digest,
  organization: z.object({
    artifact_digest: digest,
    world_bindings_digest: digest,
  }).passthrough(),
  receipt_digest: digest,
  request_digest: digest,
  resources: z.object({
    data_network: mutationReceipt,
    evidence_volume: mutationReceipt,
    secret_bindings: mutationReceipt,
    world_artifact: mutationReceipt,
  }).passthrough(),
  run_id: runId,
  selected_target: selectedTarget,
  target_selector: identifier,
  version: z.literal(SPAWNFILE_COMPOSED_PREPARATION_RECEIPT_VERSION),
  world: z.object({
    artifact_manifest_digest: digest,
    bundle_digest: digest,
  }).passthrough(),
}).passthrough();

export type SpawnfileComposedPreparationRequest = z.infer<
  typeof spawnfileComposedPreparationRequestSchema
>;
export type SpawnfileComposedPreparationReceipt = z.infer<
  typeof spawnfileComposedPreparationReceiptSchema
>;

export const parseSpawnfileComposedPreparationRequest = (
  raw: unknown,
): SpawnfileComposedPreparationRequest => {
  assertSecretFreeComposedJson(raw);
  return Object.freeze(spawnfileComposedPreparationRequestSchema.parse(raw));
};

export const createSpawnfileComposedPreparationRequestDigest = (
  raw: unknown,
): `sha256:${string}` => digestComposedJson(
  SPAWNFILE_COMPOSED_PREPARATION_REQUEST_VERSION,
  parseSpawnfileComposedPreparationRequest(raw),
);

const targetReceiptDigest = (raw: Record<string, unknown>): `sha256:${string}` =>
  digestComposedJson("spawnfile.target-resource.receipt.v1", raw);

export const parseSpawnfileComposedPreparationReceipt = (
  raw: unknown,
): SpawnfileComposedPreparationReceipt => {
  assertSecretFreeComposedJson(raw);
  const receipt = spawnfileComposedPreparationReceiptSchema.parse(raw);
  const { receipt_digest: _receiptDigest, ...body } = receipt;
  if (receipt.receipt_digest !== digestComposedJson(
    SPAWNFILE_COMPOSED_PREPARATION_RECEIPT_VERSION,
    body,
  )) throw new Error("invalid spawnfile composed-preparation receipt digest");
  const expected = [
    ["world_artifact", "resolve_world_artifact", 1],
    ["secret_bindings", "prepare_secret_bindings", 2],
    ["data_network", "create_data_network", 3],
    ["evidence_volume", "create_evidence_volume", 4],
  ] as const;
  for (const [key, operation, revision] of expected) {
    const resource = receipt.resources[key];
    const { receipt_digest: _resourceDigest, ...resourceBody } = resource;
    if (resource.receipt_digest !== targetReceiptDigest(resourceBody)
      || resource.operation !== operation
      || resource.resulting_revision !== revision
      || resource.run_id !== receipt.run_id
      || resource.descriptor_digest !== receipt.descriptor_digest
      || resource.selected_target.handle !== receipt.selected_target.handle
      || resource.selected_target.fingerprint !== receipt.selected_target.fingerprint) {
      throw new Error(`invalid spawnfile composed-preparation ${key} correlation`);
    }
  }
  if (new Set(expected.map(([key]) => receipt.resources[key].operation_handle)).size !== expected.length
    || new Set(expected.map(([key]) => receipt.resources[key].result_handle)).size !== expected.length) {
    throw new Error("invalid spawnfile composed-preparation resource identity");
  }
  return Object.freeze(receipt);
};

export const verifySpawnfileComposedPreparationReceipt = (input: Readonly<{
  readonly receipt: unknown;
  readonly request: unknown;
}>): SpawnfileComposedPreparationReceipt => {
  const request = parseSpawnfileComposedPreparationRequest(input.request);
  const receipt = parseSpawnfileComposedPreparationReceipt(input.receipt);
  if (receipt.request_digest !== createSpawnfileComposedPreparationRequestDigest(request)
    || receipt.run_id !== request.run_id
    || receipt.auth_profile !== request.auth_profile
    || receipt.target_selector !== request.target_selector
    || receipt.descriptor_digest !== request.descriptor_digest
    || receipt.organization.artifact_digest !== request.organization.artifact_digest
    || receipt.organization.world_bindings_digest !== request.organization.world_bindings_digest
    || receipt.world.artifact_manifest_digest !== request.world.artifact_manifest_digest
    || receipt.world.bundle_digest !== request.world.bundle_digest) {
    throw new Error("invalid spawnfile composed-preparation request correlation");
  }
  return receipt;
};
