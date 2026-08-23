export const PROBE_VERSION = "simfile.spawnfile-public-capability-probe.v1";
export const CAPABILITIES_VERSION = "spawnfile.capabilities.v1";
export const COMPOSED_LIFECYCLE_CONTRACT_SET_VERSION =
  "spawnfile.composed-lifecycle-contract-set.v1";
const ADMITTED_PACKAGE_VERSION = "0.1.17";
const ADMITTED_ROWS_SHA256 = "095db48660b286add81b00bdb084edc457f57b29c1c5b8a59c312e02560c4146";

const semanticVersion = (value) => /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value);
const versionedIdentifier = (value) => /^[a-z][a-z0-9.-]{0,127}\.v[1-9][0-9]*$/u.test(value);
const helpHasToken = (source, token) => source.split(/\r?\n/u).some((line) => {
  const normalized = line.trim();
  return normalized === token || normalized.startsWith(`${token} `);
});
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const rowsDigest = (rows) => createHash("sha256")
  .update(`simfile.spawnfile-capability-contract.v1\0${canonical(rows)}`, "utf8").digest("hex");

const parseCapabilities = (source) => {
  let value;
  try { value = JSON.parse(source); }
  catch { throw new Error("Spawnfile capabilities did not emit JSON"); }
  if (value?.version !== CAPABILITIES_VERSION
    || value?.implementation?.cli !== "spawnfile"
    || value?.implementation?.package !== "spawnfile"
    || value?.implementation?.version !== ADMITTED_PACKAGE_VERSION
    || value?.capabilities?.composed_lifecycle?.command_set_version !== COMPOSED_LIFECYCLE_CONTRACT_SET_VERSION
    || value?.capabilities?.composed_lifecycle?.complete !== true
    || value?.capabilities?.target_config_resolver?.output_version !== "spawnfile.target-config-resolution.v1"
    || value?.capabilities?.target_config_resolver?.target_config_version !== "spawnfile.target-default-config.v1"
    || value?.capabilities?.evidence_export_helper?.identity !== "docker-image-config-digest"
    || value?.capabilities?.evidence_export_helper?.local_context_only !== true
    || JSON.stringify(value?.capabilities?.evidence_export_helper?.prepare_command) !== JSON.stringify(["helper", "prepare-evidence-export", "--context", "<name>", "--json"])
    || value?.capabilities?.evidence_export_helper?.receipt_version !== "spawnfile.target-evidence-export-helper.prepared.v1"
    || value?.capabilities?.evidence_export_helper?.resolver_option !== "--prepare-evidence-helper"
    || value?.capabilities?.evidence_export_helper?.provisioning !== "spawnfile-owned-target-local"
    || value?.capabilities?.terminal_public_artifact?.request_version !== "spawnfile.target-public-artifact-snapshot.request.v1"
    || value?.capabilities?.terminal_public_artifact?.snapshot_version !== "spawnfile.target-public-artifact-snapshot.v1"
    || value?.capabilities?.terminal_public_artifact?.not_present_version !== "spawnfile.target-public-artifact-snapshot.not-present.v1") {
    throw new Error("Spawnfile generic capabilities receipt is invalid");
  }
  const candidates = ["command_rows", "commands", "operations", "rows"]
    .filter((key) => Array.isArray(value.capabilities.composed_lifecycle[key]));
  if (candidates.length !== 1 || value.capabilities.composed_lifecycle[candidates[0]].length !== 43) {
    throw new Error("Spawnfile generic capabilities command set is invalid");
  }
  const fields = [
    "argv", "stdin_versions", "request_versions", "receipt_versions",
    "invocation_versions", "pending_versions", "stdout",
  ];
  const rows = value.capabilities.composed_lifecycle[candidates[0]];
  for (const row of rows) {
    if (row === null || typeof row !== "object" || !fields.every((field) => Object.hasOwn(row, field))
      || !Array.isArray(row.argv) || row.argv.length === 0 || row.argv.some((arg) => typeof arg !== "string" || !arg)
      || !["stdin_versions", "request_versions", "receipt_versions", "invocation_versions", "pending_versions"]
        .every((field) => Array.isArray(row[field]) && row[field].every(versionedIdentifier))) {
      throw new Error("Spawnfile generic capabilities command row is invalid");
    }
  }
  if (rowsDigest(rows) !== ADMITTED_ROWS_SHA256) {
    throw new Error("Spawnfile generic capabilities command contract drifted");
  }
  return Object.freeze({
    command_count: rows.length,
    command_set_version: value.capabilities.composed_lifecycle.command_set_version,
    implementation: Object.freeze({ ...value.implementation }),
    version: value.version,
  });
};

export const createSpawnfileCapabilityProbe = (input) => {
  const version = input.version.trim();
  if (!semanticVersion(version)) throw new Error("Spawnfile did not report a semantic version");
  const legacyDiscovery = input.capabilities_json === undefined;
  const commands = legacyDiscovery
    ? {
      compile: helpHasToken(input.root_help, "compile"),
      target: helpHasToken(input.root_help, "target"),
      validate: helpHasToken(input.root_help, "validate"),
      resolve_config: helpHasToken(input.target_help, "resolve_config"),
      snapshot_public_artifact: helpHasToken(input.target_help, "snapshot_public_artifact"),
    }
    : { capabilities: true };
  const resolver = legacyDiscovery
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
    capabilities = parseCapabilities(input.capabilities_json);
    if (capabilities.implementation.version !== version) {
      blockers.push("capabilities_implementation_version_mismatch");
    }
  }
  return Object.freeze({
    ...(capabilities === undefined ? {} : { capabilities }),
    commands: Object.freeze(commands),
    composed: Object.freeze({ blockers: Object.freeze(blockers), ready: blockers.length === 0 }),
    development: Object.freeze({
      ready: legacyDiscovery ? commands.compile && commands.validate : true,
    }),
    implementation: Object.freeze({ package: "spawnfile", version }),
    resolver: Object.freeze(resolver),
    version: PROBE_VERSION,
  });
};
import { createHash } from "node:crypto";
