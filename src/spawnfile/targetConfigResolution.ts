import { z } from "zod";

import { canonicalComposedJson, digestComposedJson } from "../compose/json.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const context = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const helper = z.object({
  digest,
  handle: z.string().regex(/^opaque_[a-z0-9]{16,64}$/u),
  version: z.literal("spawnfile.target-evidence-export-helper.prepared.v1"),
}).strict();
const platform = z.object({
  architecture: z.enum(["amd64", "arm64"]),
  os: z.literal("linux"),
}).strict();
const targetConfig = z.object({
  context,
  preparedEvidenceHelper: helper,
  version: z.literal("spawnfile.target-default-config.v1"),
}).passthrough();
const resolution = z.object({
  base_image: z.object({ config_digest: digest, reference: z.string().min(1).max(512) }).strict(),
  context_selection: z.literal("explicit"),
  endpoint: z.object({
    class: z.literal("local"),
    transport: z.enum(["fd", "npipe", "unix"]),
  }).strict(),
  platform,
  prepared_evidence_helper: helper,
  target_config: targetConfig,
  target_config_digest: digest,
  version: z.literal("spawnfile.target-config-resolution.v1"),
}).strict();

export interface SpawnfileTargetConfigResolution {
  readonly config_bytes: Uint8Array;
  readonly identity: Readonly<{
    base_image: Readonly<{ config_digest: `sha256:${string}`; reference: string }>;
    context: string;
    endpoint_transport: "fd" | "npipe" | "unix";
    platform: Readonly<{ architecture: "amd64" | "arm64"; os: "linux" }>;
    prepared_evidence_helper: Readonly<{
      digest: `sha256:${string}`;
      handle: string;
      version: "spawnfile.target-evidence-export-helper.prepared.v1";
    }>;
    target_config_digest: `sha256:${string}`;
    version: "spawnfile.target-config-resolution.v1";
  }>;
}

/** Verifies the public receipt while retaining private config bytes only in memory. */
export const parseSpawnfileTargetConfigResolution = (
  raw: unknown,
  expectedContext: string,
): SpawnfileTargetConfigResolution => {
  const value = resolution.parse(raw);
  if (value.target_config.context !== expectedContext
    || value.prepared_evidence_helper.handle
      !== value.target_config.preparedEvidenceHelper.handle
    || value.prepared_evidence_helper.digest
      !== value.target_config.preparedEvidenceHelper.digest
    || value.target_config_digest !== digestComposedJson(
      "spawnfile.target-config-digest.v1", value.target_config,
    )) {
    throw new TypeError("Spawnfile target configuration resolution correlation is invalid");
  }
  return Object.freeze({
    config_bytes: new TextEncoder().encode(canonicalComposedJson(value.target_config)),
    identity: Object.freeze({
      base_image: Object.freeze({
        config_digest: value.base_image.config_digest as `sha256:${string}`,
        reference: value.base_image.reference,
      }),
      context: expectedContext,
      endpoint_transport: value.endpoint.transport,
      platform: Object.freeze(value.platform),
      prepared_evidence_helper: Object.freeze({
        digest: value.prepared_evidence_helper.digest as `sha256:${string}`,
        handle: value.prepared_evidence_helper.handle,
        version: value.prepared_evidence_helper.version,
      }),
      target_config_digest: value.target_config_digest as `sha256:${string}`,
      version: value.version,
    }),
  });
};
