import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createSpawnfileCapabilityProbe, PROBE_VERSION } from
  "./spawnfile-capability-probe.mjs";
import { runBoundedProcess } from "./bounded-process.mjs";
import {
  assertInstalledArtifact,
  assertOrigin,
  executableAt,
  probeIdentity,
} from "./spawnfile-install-integrity.mjs";

export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const developmentRoot = path.join(packageRoot, ".simfile-dev", "spawnfile");
export const installsRoot = path.join(developmentRoot, "installs");
export const currentPath = path.join(developmentRoot, "current.json");
export const linkedExample = path.join(
  packageRoot, "examples", "jungian-dialogue", "org", "Spawnfile",
);
export const STATE_VERSION = "simfile.spawnfile-development-state.v3";
export const CHECK_VERSION = "simfile.spawnfile-development-check.v1";

export const fail = (message) => { throw new Error(message); };
export const run = (command, args, options = {}) => runBoundedProcess(command, args, {
  ...options,
  cwd: options.cwd ?? packageRoot,
  env: options.env ?? process.env,
});

const readJson = async (filePath) => {
  try { return JSON.parse(await readFile(filePath, "utf8")); }
  catch (error) {
    return fail(`Unable to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

export const probeSpawnfileCapabilities = async (bin, runCommand = run) => {
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
  if (value?.version !== STATE_VERSION || typeof value.bin !== "string"
    || typeof value.install_root !== "string" || !path.isAbsolute(value.install_root)
    || !value.install_root.startsWith(`${installsRoot}${path.sep}`)
    || value.bin !== executableAt(value.install_root)
    || typeof value.implementation?.package_version !== "string"
    || !/^[0-9a-f]{64}$/u.test(value.implementation?.tarball_sha256 ?? "")
    || !/^[0-9a-f]{64}$/u.test(value.implementation?.executable_sha256 ?? "")
    || !/^[0-9a-f]{64}$/u.test(value.implementation?.installed_closure_sha256 ?? "")
    || value.capability_probe?.version !== PROBE_VERSION
    || !/^[0-9a-f]{64}$/u.test(value.capability_probe?.sha256 ?? "")) {
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
