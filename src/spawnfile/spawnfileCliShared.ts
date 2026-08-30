import { runSpawnfileProcess, type SpawnfileCliContext } from "./process.js";

const AUTH_PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export const assertSpawnfileAuthProfileName = (value: string | undefined): void => {
  if (value !== undefined && !AUTH_PROFILE_NAME.test(value)) {
    throw new Error("spawnfile auth profile name is not a safe identifier");
  }
};

export const assertLifecycleInvocation = (value: string): void => {
  if (!/^lci_[a-z0-9][a-z0-9_-]{15,127}$/u.test(value)) {
    throw new Error("spawnfile lifecycle invocation id is invalid");
  }
};

export const execSpawnfile = (
  context: SpawnfileCliContext,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> => runSpawnfileProcess(context, { args, signal });

export const execSpawnfileWithStdin = (
  context: SpawnfileCliContext,
  args: readonly string[],
  stdin: Uint8Array,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> => runSpawnfileProcess(context, {
  args, signal, stdin,
});

export const parseSpawnfileJson = (stdout: string, label = "CLI"): unknown => {
  try { return JSON.parse(stdout.trim()) as unknown; }
  catch {
    // JSON parser diagnostics can quote attacker-controlled stdout bytes.
    throw new Error(`spawnfile ${label} did not print valid JSON`);
  }
};
