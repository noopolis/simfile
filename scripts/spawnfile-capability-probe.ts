import { createHash } from "node:crypto";

export const PROBE_VERSION = "simfile.spawnfile-public-capability-probe.v1";
export const CAPABILITIES_VERSION = "spawnfile.capabilities.v1";
export const COMPOSED_LIFECYCLE_CONTRACT_SET_VERSION =
  "spawnfile.composed-lifecycle-contract-set.v1";
const ADMITTED_PACKAGE_VERSION = "0.1.17";
const ADMITTED_ROWS_SHA256 = "095db48660b286add81b00bdb084edc457f57b29c1c5b8a59c312e02560c4146";

type JsonObject = Record<string, unknown>;

interface CapabilityProbeInput {
  capabilities_json?: string;
  resolver_help: string;
  root_help: string;
  target_help: string;
  version: string;
}


export interface SpawnfileCapabilityProbe {
  capabilities?: Readonly<{
    command_count: number;
    command_set_version: unknown;
    implementation: Readonly<Record<string, unknown> & { version?: unknown }>;
    version: unknown;
  }>;
  commands: Readonly<Record<string, boolean>>;
  composed: Readonly<{ blockers: readonly string[]; ready: boolean }>;
  development: Readonly<{ ready: boolean }>;
  implementation: Readonly<{ package: "spawnfile"; version: string }>;
  resolver: Readonly<Record<string, boolean>>;
  version: typeof PROBE_VERSION;
}

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const objectAt = (value: unknown, key: string): JsonObject | undefined =>
  isObject(value) && isObject(value[key]) ? value[key] : undefined;

const semanticVersion = (value: string): boolean => /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value);
const versionedIdentifier = (value: string): boolean => /^[a-z][a-z0-9.-]{0,127}\.v[1-9][0-9]*$/u.test(value);
const helpHasToken = (source: string, token: string): boolean => source.split(/\r?\n/u).some((line) => {
  const normalized = line.trim();
  return normalized === token || normalized.startsWith(`${token} `);
});
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : isObject(value) ? `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const rowsDigest = (rows: readonly unknown[]): string => createHash("sha256")
  .update(`simfile.spawnfile-capability-contract.v1\0${canonical(rows)}`, "utf8").digest("hex");

const parseCapabilities = (source: string) => {
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { throw new Error("Spawnfile capabilities did not emit JSON"); }
  const implementation = objectAt(value, "implementation");
  const capabilities = objectAt(value, "capabilities");
  const composed = objectAt(capabilities, "composed_lifecycle");
  const resolver = objectAt(capabilities, "target_config_resolver");
  const evidence = objectAt(capabilities, "evidence_export_helper");
  const terminal = objectAt(capabilities, "terminal_public_artifact");
  if (!isObject(value) || value.version !== CAPABILITIES_VERSION
    || implementation?.cli !== "spawnfile"
    || implementation.package !== "spawnfile"
    || implementation.version !== ADMITTED_PACKAGE_VERSION
    || composed?.command_set_version !== COMPOSED_LIFECYCLE_CONTRACT_SET_VERSION
    || composed.complete !== true
    || resolver?.output_version !== "spawnfile.target-config-resolution.v1"
    || resolver.target_config_version !== "spawnfile.target-default-config.v1"
    || evidence?.identity !== "docker-image-config-digest"
    || evidence.local_context_only !== true
    || JSON.stringify(evidence.prepare_command) !== JSON.stringify(["helper", "prepare-evidence-export", "--context", "<name>", "--json"])
    || evidence.receipt_version !== "spawnfile.target-evidence-export-helper.prepared.v1"
    || evidence.resolver_option !== "--prepare-evidence-helper"
    || evidence.provisioning !== "spawnfile-owned-target-local"
    || terminal?.request_version !== "spawnfile.target-public-artifact-snapshot.request.v1"
    || terminal.snapshot_version !== "spawnfile.target-public-artifact-snapshot.v1"
    || terminal.not_present_version !== "spawnfile.target-public-artifact-snapshot.not-present.v1") {
    throw new Error("Spawnfile generic capabilities receipt is invalid");
  }
  const candidates = ["command_rows", "commands", "operations", "rows"]
    .filter((key) => Array.isArray(composed[key]));
  const rowsKey = candidates[0];
  if (candidates.length !== 1 || rowsKey === undefined || (composed[rowsKey] as unknown[]).length !== 43) {
    throw new Error("Spawnfile generic capabilities command set is invalid");
  }
  const fields = [
    "argv", "stdin_versions", "request_versions", "receipt_versions",
    "invocation_versions", "pending_versions", "stdout",
  ];
  const rows = composed[rowsKey] as unknown[];
  for (const row of rows) {
    if (!isObject(row) || !fields.every((field) => Object.hasOwn(row, field))
      || !Array.isArray(row.argv) || row.argv.length === 0 || row.argv.some((arg: unknown) => typeof arg !== "string" || !arg)
      || !["stdin_versions", "request_versions", "receipt_versions", "invocation_versions", "pending_versions"]
        .every((field) => Array.isArray(row[field]) && row[field].every((version: unknown) => typeof version === "string" && versionedIdentifier(version)))) {
      throw new Error("Spawnfile generic capabilities command row is invalid");
    }
  }
  if (rowsDigest(rows) !== ADMITTED_ROWS_SHA256) {
    throw new Error("Spawnfile generic capabilities command contract drifted");
  }
  return Object.freeze({
    command_count: rows.length,
    command_set_version: composed.command_set_version,
    implementation: Object.freeze({ ...implementation }),
    version: value.version,
  });
};

export const createSpawnfileCapabilityProbe = (input: CapabilityProbeInput): Readonly<SpawnfileCapabilityProbe> => {
  const version = input.version.trim();
  if (!semanticVersion(version)) throw new Error("Spawnfile did not report a semantic version");
  const capabilitiesJson = input.capabilities_json;
  const legacyDiscovery = capabilitiesJson === undefined;
  const commands: Readonly<Record<string, boolean>> = legacyDiscovery
    ? {
      compile: helpHasToken(input.root_help, "compile"),
      target: helpHasToken(input.root_help, "target"),
      validate: helpHasToken(input.root_help, "validate"),
      resolve_config: helpHasToken(input.target_help, "resolve_config"),
      snapshot_public_artifact: helpHasToken(input.target_help, "snapshot_public_artifact"),
    }
    : { capabilities: true };
  const resolver: Readonly<Record<string, boolean>> = legacyDiscovery
    ? {
      evidence_destination: helpHasToken(input.resolver_help, "--evidence-destination"),
      prepared_plan: helpHasToken(input.resolver_help, "--prepared-plan"),
    }
    : { generic_capabilities_receipt: true };
  const blockers = legacyDiscovery
    ? Object.entries(commands).filter(([, available]) => !available)
      .map(([name]) => `generic_command_unavailable:${name}`)
    : [];
  if (legacyDiscovery && !resolver.evidence_destination) {
    blockers.push("generic_resolver_option_unavailable:evidence_destination");
  }
  if (legacyDiscovery && !resolver.prepared_plan) {
    blockers.push("generic_resolver_option_unavailable:prepared_plan");
  }
  let capabilities;
  if (legacyDiscovery) {
    blockers.push(
      "generic_capabilities_receipt_unavailable",
      "evidence_export_helper_capability_unverifiable",
      "typed_terminal_not_present_capability_unverifiable",
    );
  } else {
    capabilities = parseCapabilities(capabilitiesJson);
    if (capabilities.implementation.version !== version) {
      blockers.push("capabilities_implementation_version_mismatch");
    }
  }
  return Object.freeze({
    ...(capabilities === undefined ? {} : { capabilities }),
    commands: Object.freeze(commands),
    composed: Object.freeze({ blockers: Object.freeze(blockers), ready: blockers.length === 0 }),
    development: Object.freeze({
      ready: legacyDiscovery ? commands.compile === true && commands.validate === true : true,
    }),
    implementation: Object.freeze({ package: "spawnfile", version }),
    resolver: Object.freeze(resolver),
    version: PROBE_VERSION,
  });
};
