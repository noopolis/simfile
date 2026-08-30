import path from "node:path";

import { z } from "zod";

import { assertSecretFreeComposedJson } from "./json.js";
import type { ComposedRunConfiguration } from "./run.js";

export const COMPOSED_EXECUTION_VERSION = "simfile.composed-execution.v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const handle = z.string().regex(/^opaque_[a-z0-9]{16,64}$/u);
const identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const absolutePath = z.string().max(4_096).refine((value) =>
  path.isAbsolute(value) && path.normalize(value) === value && value !== path.parse(value).root);
const capability = z.object({
  identity: z.string().regex(/^[a-z][a-z0-9.-]{0,127}\.v[1-9][0-9]*$/u),
  manifest_digest: digest,
}).strict();
const selectedTarget = z.object({
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{32}$/u),
  handle,
}).strict();
const processEnvironment = z.record(
  z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/u),
  z.string().min(1).max(4_096),
).refine((value) => Object.keys(value).length <= 32);
const readiness = z.object({
  artifact_digest: digest.nullable(),
  bundle_digest: digest,
  capabilities: z.array(capability).max(32).optional(),
  capability_manifest_digests: z.array(digest).min(1).max(4_096),
  mechanics_sha256: digest,
  normalized_checkpoint_sha256: digest,
  run_id: z.string().min(1).max(128),
  world_instance_id: z.string().min(1).max(128),
}).strict();
export const composedExecutionSchema = z.object({
  configuration: z.object({
    organization_expectation: z.object({
      deployment_name: identifier,
      member_engines: z.record(z.string().min(1).max(128), z.string().min(1).max(128)),
      moltnet_release: z.object({
        architecture: z.enum(["amd64", "arm64"]),
        asset_sha256: digest,
        release_version: z.string().min(1).max(128),
        source_revision: z.string().regex(/^[a-f0-9]{40}$/u),
      }).strict().optional(),
      selected_target_receipt_digest: digest,
      unit_id: identifier,
      world_binding_digest: digest,
    }).strict(),
    readiness_expectation: readiness,
    terminal_tick: z.number().int().min(1).max(1_000_000_000),
    topology_expectation: z.object({
      selected_target: selectedTarget,
      topology_request_digest: digest.optional(),
    }).strict(),
  }).strict(),
  provider: z.object({
    compiled_output_directory: absolutePath,
    evidence_destination_directory: absolutePath,
    evidence_mount_path: z.string().regex(/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u),
    lifecycle_invocations: z.object({
      down: z.string().regex(/^lci_[a-z0-9][a-z0-9_-]{15,127}$/u),
      export: z.string().regex(/^lci_[a-z0-9][a-z0-9_-]{15,127}$/u),
      up: z.string().regex(/^lci_[a-z0-9][a-z0-9_-]{15,127}$/u),
    }).strict(),
    organization_handoff: z.object({
      env_file: absolutePath,
      selected_target_receipt_file: absolutePath,
      world_bindings_file: absolutePath,
    }).strict(),
    organization_container_name: identifier,
    organization_image_tag: z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,127}:[a-z0-9][a-z0-9._-]{0,63}$/u),
    organization_path: absolutePath,
    process_environment: processEnvironment.optional(),
    spawnfile_bin: absolutePath,
    spawnfile_cwd: absolutePath,
    spawnfile_capability_contract_digest: digest.optional(),
    spawnfile_executable_sha256: digest,
    spawnfile_package_version: z.literal("0.1.17").optional(),
    target_resolution: z.object({
      base_image: z.object({
        config_digest: digest,
        reference: z.string().min(1).max(512),
      }).strict(),
      context: identifier,
      endpoint_transport: z.enum(["fd", "npipe", "unix"]),
      platform: z.object({
        architecture: z.enum(["amd64", "arm64"]),
        os: z.literal("linux"),
      }).strict(),
      prepared_evidence_helper: z.object({
        digest,
        handle,
        version: z.literal("spawnfile.target-evidence-export-helper.prepared.v1"),
      }).strict(),
      target_config_digest: digest,
      version: z.literal("spawnfile.target-config-resolution.v1"),
    }).strict().optional(),
    terminal_artifact: z.object({
      id: identifier,
      max_bytes: z.number().int().min(1).max(131_072),
      path: z.string().regex(/^\/tmp\/spawnfile-public\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u),
    }).strict(),
    world_evidence_export: z.object({
      archive_path: absolutePath.refine((value) => path.extname(value) === ".tar"),
      destination_directory: absolutePath,
    }).strict().optional(),
    world_readiness_port: z.number().int().min(1).max(65_535),
  }).strict(),
  secret_bindings: z.array(z.object({
    name: identifier,
    scope: identifier,
    source_handle: handle,
  }).strict()).min(1).max(32),
  version: z.literal(COMPOSED_EXECUTION_VERSION),
}).strict();

export type ComposedExecution = z.infer<typeof composedExecutionSchema>;

export const parseComposedExecution = (raw: unknown): ComposedExecution => {
  assertSecretFreeComposedJson(raw);
  const value = composedExecutionSchema.parse(raw);
  return Object.freeze(value);
};

export const composedRunConfiguration = (
  execution: ComposedExecution,
): ComposedRunConfiguration => ({
  deployment_name: execution.configuration.organization_expectation.deployment_name,
  organization_expectation: execution.configuration.organization_expectation,
  readiness_expectation: execution.configuration.readiness_expectation,
  terminal_tick: execution.configuration.terminal_tick,
  topology_expectation: execution.configuration.topology_expectation,
});
