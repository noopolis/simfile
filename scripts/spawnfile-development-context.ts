import { readFile } from "node:fs/promises";
import path from "node:path";

import { createSpawnfileCapabilityProbe, PROBE_VERSION } from
  "./spawnfile-capability-probe.ts";
import { runBoundedProcess, type BoundedProcessResult } from "./bounded-process.ts";
import { resolvePackageRoot } from "./package-root.ts";
import {
  assertInstalledArtifact,
  assertOrigin,
  executableAt,
  probeIdentity,
} from "./spawnfile-install-integrity.ts";

export const packageRoot = resolvePackageRoot(import.meta.url);
export const developmentRoot = path.join(packageRoot, ".simfile-dev", "spawnfile");
export const installsRoot = path.join(developmentRoot, "installs");
export const currentPath = path.join(developmentRoot, "current.json");
export const linkedExample = path.join(
  packageRoot, "examples", "jungian-dialogue", "org", "Spawnfile",
);
export const STATE_VERSION = "simfile.spawnfile-development-state.v3";
export const CHECK_VERSION = "simfile.spawnfile-development-check.v1";

type RunCommand = (
  command: string,
  args: readonly string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; maxOutputBytes?: number; timeoutMs?: number }
) => Promise<BoundedProcessResult>;
type JsonObject = Record<string, unknown>;

export interface DevelopmentImplementationIdentity {
  executable_sha256: string;
  installed_closure_sha256: string;
  package_version: string;
  tarball_sha256: string;
}

export interface DevelopmentState {
  bin: string;
  capability_probe: Readonly<{ sha256: string; version: string }>;
  implementation: DevelopmentImplementationIdentity;
  install_root: string;
  origin: unknown;
  version: typeof STATE_VERSION;
}

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isDevelopmentState = (value: unknown): value is DevelopmentState => {
  if (!isObject(value) || value.version !== STATE_VERSION
    || typeof value.bin !== "string"
    || typeof value.install_root !== "string"
    || !path.isAbsolute(value.install_root)
    || !value.install_root.startsWith(`${installsRoot}${path.sep}`)
    || value.bin !== executableAt(value.install_root)
    || !isObject(value.implementation)
    || typeof value.implementation.package_version !== "string"
    || !/^[0-9a-f]{64}$/u.test(String(value.implementation.tarball_sha256 ?? ""))
    || !/^[0-9a-f]{64}$/u.test(String(value.implementation.executable_sha256 ?? ""))
    || !/^[0-9a-f]{64}$/u.test(String(value.implementation.installed_closure_sha256 ?? ""))
    || !isObject(value.capability_probe)
    || value.capability_probe.version !== PROBE_VERSION
    || !/^[0-9a-f]{64}$/u.test(String(value.capability_probe.sha256 ?? ""))) {
    return false;
  }
  return true;
};

export const fail = (message: string): never => { throw new Error(message); };
export const run = (
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; maxOutputBytes?: number; timeoutMs?: number } = {}
) => runBoundedProcess(command, args, {
  ...options,
  cwd: options.cwd ?? packageRoot,
  env: options.env ?? process.env,
});

const readJson = async (filePath: string): Promise<unknown> => {
  try { return JSON.parse(await readFile(filePath, "utf8")); }
  catch (error) {
    return fail(`Unable to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

export const probeSpawnfileCapabilities = async (bin: string, runCommand: RunCommand = run) => {
  const [version, capabilities] = await Promise.all([
    runCommand(bin, ["--version"]),
    runCommand(bin, ["capabilities", "--json"]).then(({ stdout }) => stdout)
      .catch(() => undefined),
  ]);
  if (capabilities !== undefined) {
    return createSpawnfileCapabilityProbe({ capabilities_json: capabilities,
      resolver_help: "", root_help: "", target_help: "", version: version.stdout });
  }
  const unavailableHelp = { stdout: "" };
  const [rootHelp, targetHelp, resolverHelp] = await Promise.all([
    runCommand(bin, ["--help"]),
    runCommand(bin, ["target", "--help"]).catch(() => unavailableHelp),
    runCommand(bin, ["target", "resolve_config", "--help"]).catch(() => unavailableHelp),
  ]);
  return createSpawnfileCapabilityProbe({ resolver_help: resolverHelp.stdout,
    root_help: rootHelp.stdout, target_help: targetHelp.stdout, version: version.stdout });
};

export const readCurrentState = async () => {
  const value = await readJson(currentPath);
  if (!isDevelopmentState(value)) {
    return fail("Spawnfile development state is invalid; rerun dev:spawnfile:setup");
  }
  await assertOrigin(value.origin);
  await assertInstalledArtifact(value.install_root, value.implementation);
  const probe = await probeSpawnfileCapabilities(value.bin);
  if (probeIdentity(probe).sha256 !== value.capability_probe.sha256) {
    return fail("Spawnfile capability probe drifted; rerun dev:spawnfile:setup");
  }
  return Object.freeze({
    bin: value.bin, capability_probe: probe,
    capability_probe_identity: value.capability_probe,
    implementation: value.implementation, install_root: value.install_root,
    origin: value.origin, version: value.version,
  });
};

export { createSpawnfileCapabilityProbe, PROBE_VERSION };
