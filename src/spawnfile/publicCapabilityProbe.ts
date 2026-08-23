import type { BootstrapLocalExecutableIdentity } from "./process.js";
import { runSpawnfileProcess } from "./process.js";
import { parseSpawnfileCapabilitiesReceipt, type SpawnfileCapabilitiesReceipt } from "./publicCapabilityContract.js";

export { parseSpawnfileCapabilitiesReceipt, SPAWNFILE_ADMITTED_PACKAGE_VERSION,
  SPAWNFILE_CAPABILITIES_VERSION, SPAWNFILE_COMPOSED_LIFECYCLE_CONTRACT_SET_VERSION,
  type SpawnfileCapabilitiesReceipt, type SpawnfileCapabilityCommandRow } from "./publicCapabilityContract.js";

export const SPAWNFILE_PUBLIC_CAPABILITY_PROBE_VERSION =
  "simfile.spawnfile-public-capability-probe.v1" as const;
const semanticVersion = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const parseVersion = (value: string): string => {
  if (!semanticVersion.test(value)) throw new TypeError("Spawnfile did not report a semantic version");
  return value;
};

export interface SpawnfilePublicCapabilityProbe {
  readonly blockers: readonly string[];
  readonly capabilities?: SpawnfileCapabilitiesReceipt;
  readonly commands: Readonly<Record<string, boolean>>;
  readonly implementation: Readonly<{ package: "spawnfile"; version: string }>;
  readonly ready: boolean;
  readonly resolver: Readonly<Record<string, boolean>>;
  readonly version: typeof SPAWNFILE_PUBLIC_CAPABILITY_PROBE_VERSION;
}

const helpHasToken = (help: string, token: string): boolean =>
  help.split(/\r?\n/u).some((line) => {
    const normalized = line.trim();
    return normalized === token || normalized.startsWith(`${token} `);
  });
const command = (help: string, name: string): boolean => helpHasToken(help, name);
const option = (help: string, name: string): boolean => helpHasToken(help, `--${name}`);

const parseJson = (source: string): unknown => {
  try { return JSON.parse(source) as unknown; }
  catch { throw new TypeError("Spawnfile capabilities did not emit JSON"); }
};

const legacyProbe = (input: Readonly<{
  resolver_help: string;
  root_help: string;
  target_help: string;
  version: string;
}>): SpawnfilePublicCapabilityProbe => {
  const version = parseVersion(input.version.trim());
  const commands = Object.freeze({
    compile: command(input.root_help, "compile"),
    resolve_config: command(input.target_help, "resolve_config"),
    snapshot_public_artifact: command(input.target_help, "snapshot_public_artifact"),
    target: command(input.root_help, "target"),
    validate: command(input.root_help, "validate"),
  });
  const resolver = Object.freeze({
    evidence_destination: option(input.resolver_help, "evidence-destination"),
    prepared_plan: option(input.resolver_help, "prepared-plan"),
  });
  const blockers = Object.entries(commands).filter(([, available]) => !available)
    .map(([name]) => `generic_command_unavailable:${name}`);
  if (!resolver.evidence_destination) {
    blockers.push("generic_resolver_option_unavailable:evidence_destination");
  }
  if (!resolver.prepared_plan) {
    blockers.push("generic_resolver_option_unavailable:prepared_plan");
  }
  blockers.push(
    "generic_capabilities_receipt_unavailable",
    "evidence_export_helper_capability_unverifiable",
    "typed_terminal_not_present_capability_unverifiable",
  );
  return Object.freeze({
    blockers: Object.freeze(blockers),
    commands,
    implementation: Object.freeze({ package: "spawnfile" as const, version }),
    ready: false,
    resolver,
    version: SPAWNFILE_PUBLIC_CAPABILITY_PROBE_VERSION,
  });
};

/**
 * Classifies a generic capability receipt. Simfile parses every declared
 * command-row field and admits only the pinned packaged contract wired to the
 * journal-owned provider seam.
 */
export const createSpawnfilePublicCapabilityProbe = (input: Readonly<{
  capabilities_json?: string;
  resolver_help: string;
  root_help: string;
  target_help: string;
  version: string;
}>): SpawnfilePublicCapabilityProbe => {
  if (input.capabilities_json === undefined) return legacyProbe(input);
  const capabilities = parseSpawnfileCapabilitiesReceipt(parseJson(input.capabilities_json));
  const version = parseVersion(input.version.trim());
  const blockers: string[] = [];
  if (capabilities.implementation.version !== version) {
    blockers.push("capabilities_implementation_version_mismatch");
  }
  return Object.freeze({
    blockers: Object.freeze(blockers),
    capabilities,
    commands: Object.freeze({ capabilities: true }),
    implementation: Object.freeze({ package: "spawnfile" as const, version }),
    ready: blockers.length === 0,
    resolver: Object.freeze({ generic_capabilities_receipt: true }),
    version: SPAWNFILE_PUBLIC_CAPABILITY_PROBE_VERSION,
  });
};

type ProbeRunner = (
  args: readonly string[],
  signal: AbortSignal | undefined,
) => Promise<Readonly<{ stdout: string }>>;

/** Invokes only bounded version/help/capability discovery commands; no mutation occurs. */
export const probeSpawnfilePublicCapabilities = async (input: Readonly<{
  cwd: string;
  environment: NodeJS.ProcessEnv;
  identity: BootstrapLocalExecutableIdentity;
  run?: ProbeRunner;
  signal?: AbortSignal;
}>): Promise<SpawnfilePublicCapabilityProbe> => {
  const run: ProbeRunner = input.run ?? (async (args, signal) =>
    runSpawnfileProcess({
      bootstrapLocalExecutableIdentity: input.identity,
      cwd: input.cwd,
      env: input.environment,
      spawnfileBin: input.identity.path,
      timeoutMs: 10_000,
    }, { args, signal }));
  const [version, capabilityResult] = await Promise.all([
    run(["--version"], input.signal),
    run(["capabilities", "--json"], input.signal).then((result) => result.stdout).catch(() => undefined),
  ]);
  if (capabilityResult !== undefined) {
    return createSpawnfilePublicCapabilityProbe({
      capabilities_json: capabilityResult,
      resolver_help: "",
      root_help: "",
      target_help: "",
      version: version.stdout,
    });
  }
  const unavailable = Object.freeze({ stdout: "" });
  const [rootHelp, targetHelp, resolverHelp] = await Promise.all([
    run(["--help"], input.signal),
    run(["target", "--help"], input.signal).catch(() => unavailable),
    run(["target", "resolve_config", "--help"], input.signal).catch(() => unavailable),
  ]);
  return legacyProbe({
    resolver_help: resolverHelp.stdout,
    root_help: rootHelp.stdout,
    target_help: targetHelp.stdout,
    version: version.stdout,
  });
};

export const assertSpawnfileCompositionCapabilities = (
  probe: SpawnfilePublicCapabilityProbe,
): void => {
  if (!probe.ready) {
    throw new TypeError(
      `Simfile cannot verify the generic Spawnfile capabilities required for composition (${probe.blockers.join(", ")})`,
    );
  }
};
