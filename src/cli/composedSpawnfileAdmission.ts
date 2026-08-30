import path from "node:path";

import {
  COMPOSED_SPAWNFILE_OPERATION_TIMEOUT_MS,
  captureBootstrapLocalExecutableIdentity,
  type BootstrapLocalExecutableIdentity,
  type BootstrapSpawnfileCliContext,
} from "../spawnfile/process.js";
import {
  assertSpawnfileCompositionCapabilities,
  probeSpawnfilePublicCapabilities,
} from "../spawnfile/publicCapabilityProbe.js";
import { bootstrapOption } from "./composedBootstrapPaths.js";

export interface AdmittedComposedSpawnfile {
  readonly capability_contract_digest: `sha256:${string}`;
  readonly context: BootstrapSpawnfileCliContext;
  readonly identity: BootstrapLocalExecutableIdentity;
  readonly package_version: "0.1.17";
  readonly process_environment: Readonly<Record<string, string>>;
}

export const admitComposedSpawnfile = async (input: Readonly<{
  environment: NodeJS.ProcessEnv;
  project_root: string;
  run_id: string;
  spawnfile_home: string;
  signal?: AbortSignal;
}>): Promise<AdmittedComposedSpawnfile> => {
  const configured = bootstrapOption(input.environment, "SPAWNFILE_BIN");
  if (configured === undefined || !path.isAbsolute(configured)
    || path.normalize(configured) !== configured) {
    throw new TypeError("SPAWNFILE_BIN must be an absolute installed executable path");
  }
  const identity = await captureBootstrapLocalExecutableIdentity(configured);
  const processEnvironment: Record<string, string> = {
    NOOPOLIS_RUN_ID: input.run_id,
    SPAWNFILE_HOME: input.spawnfile_home,
  };
  for (const name of ["SPAWNFILE_MOLTNET_RELEASE_DIR",
    "SPAWNFILE_MOLTNET_TARGET_ARCH"] as const) {
    const value = bootstrapOption(input.environment, name);
    if (value !== undefined) processEnvironment[name] = name.endsWith("_DIR")
      ? path.resolve(value) : value;
  }
  const environment = { ...input.environment, ...processEnvironment };
  const capabilities = await probeSpawnfilePublicCapabilities({
    cwd: input.project_root, environment, identity, signal: input.signal,
  });
  assertSpawnfileCompositionCapabilities(capabilities);
  if (capabilities.capabilities?.implementation.version !== "0.1.17") {
    throw new TypeError("Simfile requires the exact Spawnfile 0.1.17 package contract");
  }
  return Object.freeze({
    capability_contract_digest: capabilities.capabilities.command_rows_digest,
    context: Object.freeze({
      bootstrapLocalExecutableIdentity: identity,
      cwd: input.project_root,
      env: environment,
      spawnfileBin: identity.path,
      timeoutMs: COMPOSED_SPAWNFILE_OPERATION_TIMEOUT_MS,
    }),
    identity,
    package_version: "0.1.17" as const,
    process_environment: Object.freeze(processEnvironment),
  });
};

export const revalidateComposedSpawnfile = async (input: Readonly<{
  capability_contract_digest: string;
  context: BootstrapSpawnfileCliContext;
  signal?: AbortSignal;
}>): Promise<void> => {
  if (input.context.cwd === undefined || input.context.env === undefined) {
    throw new TypeError("Spawnfile recovery context is incomplete");
  }
  const identity = await captureBootstrapLocalExecutableIdentity(input.context.spawnfileBin);
  if (identity.path !== input.context.bootstrapLocalExecutableIdentity.path
    || identity.sha256 !== input.context.bootstrapLocalExecutableIdentity.sha256) {
    throw new TypeError("Spawnfile executable identity changed");
  }
  const probe = await probeSpawnfilePublicCapabilities({ cwd: input.context.cwd,
    environment: input.context.env, identity, signal: input.signal });
  assertSpawnfileCompositionCapabilities(probe);
  if (probe.capabilities?.command_rows_digest !== input.capability_contract_digest
    || probe.capabilities.implementation.version !== "0.1.17") {
    throw new TypeError("Spawnfile package contract changed");
  }
};

export const bindComposedTargetArchitecture = (
  admitted: AdmittedComposedSpawnfile,
  architecture: "amd64" | "arm64",
): AdmittedComposedSpawnfile => {
  const existing = admitted.process_environment.SPAWNFILE_MOLTNET_TARGET_ARCH;
  if (existing !== undefined && existing !== architecture) {
    throw new TypeError("Spawnfile target architecture contradicts the selected context");
  }
  const processEnvironment = Object.freeze({ ...admitted.process_environment,
    SPAWNFILE_MOLTNET_TARGET_ARCH: architecture });
  return Object.freeze({ ...admitted,
    context: Object.freeze({ ...admitted.context,
      env: { ...admitted.context.env, ...processEnvironment } }),
    process_environment: processEnvironment });
};
