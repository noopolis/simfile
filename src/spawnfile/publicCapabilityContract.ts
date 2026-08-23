import { z } from "zod";

import { digestComposedJson } from "../compose/json.js";

export const SPAWNFILE_CAPABILITIES_VERSION = "spawnfile.capabilities.v1" as const;
export const SPAWNFILE_COMPOSED_LIFECYCLE_CONTRACT_SET_VERSION =
  "spawnfile.composed-lifecycle-contract-set.v1" as const;
export const SPAWNFILE_ADMITTED_PACKAGE_VERSION = "0.1.17" as const;
const commandRowsDigest = "sha256:095db48660b286add81b00bdb084edc457f57b29c1c5b8a59c312e02560c4146";

const versioned = z.string().regex(/^[a-z][a-z0-9.-]{0,127}\.v[1-9][0-9]*$/u);
const row = z.object({ argv: z.array(z.string().min(1).max(4_096)).min(1).max(32),
  invocation_versions: z.array(versioned).max(32), pending_versions: z.array(versioned).max(32),
  receipt_versions: z.array(versioned).max(32), request_versions: z.array(versioned).max(32),
  stdin_versions: z.array(versioned).max(32), stdout: z.unknown() }).passthrough();
const auxiliary = z.object({
  evidence_export_helper: z.object({ identity: z.literal("docker-image-config-digest"),
    local_context_only: z.literal(true), prepare_command: z.tuple([z.literal("helper"),
      z.literal("prepare-evidence-export"), z.literal("--context"), z.literal("<name>"), z.literal("--json")]),
    provisioning: z.literal("spawnfile-owned-target-local"),
    receipt_version: z.literal("spawnfile.target-evidence-export-helper.prepared.v1"),
    resolver_option: z.literal("--prepare-evidence-helper") }).strict(),
  terminal_public_artifact: z.object({ not_present_version:
    z.literal("spawnfile.target-public-artifact-snapshot.not-present.v1"), request_version:
    z.literal("spawnfile.target-public-artifact-snapshot.request.v1"), snapshot_version:
    z.literal("spawnfile.target-public-artifact-snapshot.v1") }).strict(),
  target_config_resolver: z.object({ command: z.tuple([z.literal("target"), z.literal("resolve_config")]),
    output_version: z.literal("spawnfile.target-config-resolution.v1"), prepared_plan_version:
    z.literal("spawnfile.target-config-prepared-plan.v1"), target_config_digest_version:
    z.literal("spawnfile.target-config-digest.v1"), target_config_version:
    z.literal("spawnfile.target-default-config.v1") }).strict(),
}).passthrough();

export interface SpawnfileCapabilityCommandRow { readonly argv: readonly string[];
  readonly invocation_versions: readonly string[]; readonly pending_versions: readonly string[];
  readonly receipt_versions: readonly string[]; readonly request_versions: readonly string[];
  readonly stdin_versions: readonly string[]; readonly stdout: unknown; }
export interface SpawnfileCapabilitiesReceipt { readonly command_rows_digest: `sha256:${string}`;
  readonly command_rows: readonly SpawnfileCapabilityCommandRow[];
  readonly command_set_version: typeof SPAWNFILE_COMPOSED_LIFECYCLE_CONTRACT_SET_VERSION;
  readonly implementation: Readonly<{ cli: "spawnfile"; package: "spawnfile"; version: string }>;
  readonly version: typeof SPAWNFILE_CAPABILITIES_VERSION; }

const rows = (raw: unknown): readonly SpawnfileCapabilityCommandRow[] => {
  const record = z.record(z.string(), z.unknown()).parse(raw);
  const candidate = ["command_rows", "commands", "operations", "rows"].filter((key) => Array.isArray(record[key]));
  if (candidate.length !== 1) throw new TypeError("Spawnfile capabilities command rows are ambiguous or absent");
  const parsed = z.array(row).length(43).parse(record[candidate[0]!]);
  const required = ["argv", "stdin_versions", "request_versions", "receipt_versions", "invocation_versions", "pending_versions", "stdout"];
  if (parsed.some((value) => !required.every((field) => Object.hasOwn(value, field)))) {
    throw new TypeError("Spawnfile capabilities command row is incomplete");
  }
  return Object.freeze(parsed.map((value) => Object.freeze({ argv: Object.freeze([...value.argv]),
    invocation_versions: Object.freeze([...value.invocation_versions]), pending_versions: Object.freeze([...value.pending_versions]),
    receipt_versions: Object.freeze([...value.receipt_versions]), request_versions: Object.freeze([...value.request_versions]),
    stdin_versions: Object.freeze([...value.stdin_versions]), stdout: value.stdout })));
};

/** Independently pins the exact published 0.1.17 public CLI contract. */
export const parseSpawnfileCapabilitiesReceipt = (raw: unknown): SpawnfileCapabilitiesReceipt => {
  const root = z.object({ capabilities: auxiliary.extend({ composed_lifecycle: z.object({
    command_set_version: z.literal(SPAWNFILE_COMPOSED_LIFECYCLE_CONTRACT_SET_VERSION), complete: z.literal(true),
  }).passthrough() }), implementation: z.object({ cli: z.literal("spawnfile"), package: z.literal("spawnfile"),
    version: z.literal(SPAWNFILE_ADMITTED_PACKAGE_VERSION) }).strict(),
  version: z.literal(SPAWNFILE_CAPABILITIES_VERSION) }).passthrough().parse(raw);
  const commandRows = rows(root.capabilities.composed_lifecycle);
  const digest = digestComposedJson("simfile.spawnfile-capability-contract.v1", commandRows);
  if (digest !== commandRowsDigest) throw new TypeError("Spawnfile composed lifecycle command contract drifted");
  return Object.freeze({ command_rows: commandRows, command_rows_digest: digest,
    command_set_version: root.capabilities.composed_lifecycle.command_set_version,
    implementation: Object.freeze(root.implementation), version: root.version });
};
