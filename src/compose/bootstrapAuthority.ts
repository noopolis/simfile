import path from "node:path";

import { z } from "zod";

import { assertSecretFreeComposedJson, digestComposedJson } from "./json.js";

export const COMPOSED_BOOTSTRAP_CAPSULE_VERSION =
  "simfile.composed-bootstrap-capsule.v2" as const;
export const COMPOSED_BOOTSTRAP_BINDING_VERSION =
  "simfile.composed-bootstrap-binding.v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const absolutePath = z.string().max(4_096).refine((value) =>
  path.isAbsolute(value) && path.normalize(value) === value
  && value !== path.parse(value).root);
const safeEnvironment = z.record(
  z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/u),
  z.string().min(1).max(4_096),
).refine((value) => Object.keys(value).length <= 16);

export const composedBootstrapCapsuleSchema = z.object({
  command_mode: z.enum(["live", "lifecycle-replay-smoke"]),
  paths: z.object({
    compiled: absolutePath,
    env_file: absolutePath,
    grants_file: absolutePath,
    journal: absolutePath,
    organization_evidence: absolutePath,
    organization_path: absolutePath,
    preflight_report: absolutePath,
    prepared_plan: absolutePath,
    run: absolutePath,
    selected_target_file: absolutePath,
    simfile: absolutePath,
    support_root: absolutePath,
    world_bindings_file: absolutePath,
    world_evidence: absolutePath,
    world_evidence_archive: absolutePath,
  }).strict(),
  project: z.object({
    compile_fingerprint: z.string().min(1).max(256),
    descriptor_digest: digest,
    preflight_report_digest: digest,
    seed: z.string().min(1).max(4_096),
    simfile_source_digest: digest,
    spawnfile_source_digest: digest,
  }).strict(),
  provider: z.object({
    base_image: z.string().min(1).max(512),
    capability_contract_digest: digest,
    context: identifier,
    docker_command: z.string().min(1).max(1_024),
    process_environment: safeEnvironment,
    spawnfile_bin: absolutePath,
    spawnfile_cwd: absolutePath,
    spawnfile_executable_sha256: digest,
    spawnfile_package_version: z.literal("0.1.17"),
  }).strict(),
  run_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
  version: z.literal(COMPOSED_BOOTSTRAP_CAPSULE_VERSION),
}).strict();

const helper = z.object({
  digest,
  handle: z.string().regex(/^opaque_[a-z0-9]{16,64}$/u),
  version: z.literal("spawnfile.target-evidence-export-helper.prepared.v1"),
}).strict();
const selectedTarget = z.object({
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{32}$/u),
  handle: z.string().regex(/^opaque_[a-z0-9]{16,64}$/u),
}).strict();

export const composedBootstrapBindingSchema = z.object({
  bootstrap_authority_digest: digest,
  bootstrap_digest: digest,
  execution_digest: digest,
  receipt_digest: digest,
  request_digest: digest,
  run_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
  target: z.object({
    context: identifier,
    prepared_evidence_helper: helper,
    selected_target: selectedTarget,
    selected_target_receipt_digest: digest,
    target_config_digest: digest,
  }).strict(),
  version: z.literal(COMPOSED_BOOTSTRAP_BINDING_VERSION),
}).strict();

export type ComposedBootstrapCapsule = z.infer<typeof composedBootstrapCapsuleSchema>;
export type ComposedBootstrapBinding = z.infer<typeof composedBootstrapBindingSchema>;

export const parseComposedBootstrapCapsule = (raw: unknown): ComposedBootstrapCapsule => {
  assertSecretFreeComposedJson(raw);
  return Object.freeze(composedBootstrapCapsuleSchema.parse(raw));
};

export const composedBootstrapDigest = (raw: unknown): `sha256:${string}` =>
  digestComposedJson(COMPOSED_BOOTSTRAP_CAPSULE_VERSION, parseComposedBootstrapCapsule(raw));

export const parseComposedBootstrapBinding = (raw: unknown): ComposedBootstrapBinding => {
  assertSecretFreeComposedJson(raw);
  const value = composedBootstrapBindingSchema.parse(raw);
  const { receipt_digest: _receiptDigest, ...body } = value;
  if (value.receipt_digest !== digestComposedJson(COMPOSED_BOOTSTRAP_BINDING_VERSION, body)) {
    throw new TypeError("composed bootstrap binding digest is invalid");
  }
  return Object.freeze(value);
};

export const createComposedBootstrapBinding = (
  body: Omit<ComposedBootstrapBinding, "receipt_digest" | "version">,
): ComposedBootstrapBinding => parseComposedBootstrapBinding({
  ...body,
  receipt_digest: digestComposedJson(COMPOSED_BOOTSTRAP_BINDING_VERSION, {
    ...body,
    version: COMPOSED_BOOTSTRAP_BINDING_VERSION,
  }),
  version: COMPOSED_BOOTSTRAP_BINDING_VERSION,
});
