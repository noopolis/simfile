#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  probeSpawnfileCapabilities,
  readCurrentState,
} from "./spawnfile-development.ts";
import { runBoundedProcess } from "./bounded-process.ts";
import { isMainModule } from "./entrypoint.ts";
import { resolvePackageRoot } from "./package-root.ts";
import { proveSpawnfileLocalEndpoint } from "./spawnfile-local-endpoint.ts";

const packageRoot = resolvePackageRoot(import.meta.url);
const builtCli = path.join(packageRoot, "dist", "cli", "index.js");
const composedExample = path.join(packageRoot, "examples", "jungian-dialogue", "Simfile");
const internalSmokeExample = path.join(
  packageRoot, "examples", "composed-development", "Simfile",
);
type OwnFlagKey = "baseImage" | "context" | "dockerCommand";

export interface SmokeRunArguments {
  baseImage?: string;
  context: string;
  dockerCommand?: string;
  internalLifecycleSmoke: boolean;
  simfileArgs: readonly string[];
}

export interface ComposedSmokeInvocation extends SmokeRunArguments {
  command: string;
  command_args: readonly string[];
  example: string;
  mode: "lifecycle-replay-smoke";
  out: string;
  run_id: string;
  simfileArgs: readonly string[];
}

const fail = (message: string): never => { throw new Error(message); };
const takeValue = (argv: readonly string[], index: number, flag: string): { consumed: number; value: string } | undefined => {
  const arg = argv[index];
  if (arg === flag) {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) return fail(`${flag} requires a value`);
    return { consumed: 2, value };
  }
  if (arg?.startsWith(`${flag}=`)) {
    const value = arg.slice(flag.length + 1);
    if (!value) return fail(`${flag} requires a value`);
    return { consumed: 1, value };
  }
  return undefined;
};

export const parseSmokeRunArguments = (argv: readonly string[]): SmokeRunArguments => {
  let context: string | undefined;
  let baseImage: string | undefined;
  let dockerCommand: string | undefined;
  let internalLifecycleSmoke = false;
  const simfileArgs: string[] = [];
  const values = ["--out", "--run-id", "--seed"];
  for (let index = 0; index < argv.length;) {
    const ownFlags: Array<readonly [string, OwnFlagKey]> = [
      ["--context", "context"],
      ["--base-image", "baseImage"],
      ["--docker-command", "dockerCommand"],
    ];
    let matched = false;
    for (const [flag, key] of ownFlags) {
      const parsed = takeValue(argv, index, flag);
      if (parsed === undefined) continue;
      const existing: Record<OwnFlagKey, string | undefined> = { context, baseImage, dockerCommand };
      if (existing[key] !== undefined) return fail(`Duplicate ${flag}`);
      if (key === "context") context = parsed.value;
      if (key === "baseImage") baseImage = parsed.value;
      if (key === "dockerCommand") dockerCommand = parsed.value;
      index += parsed.consumed;
      matched = true;
      break;
    }
    if (matched) continue;
    if (argv[index] === "--internal-lifecycle-smoke") {
      if (internalLifecycleSmoke) return fail("Duplicate --internal-lifecycle-smoke");
      internalLifecycleSmoke = true;
      index += 1;
      continue;
    }
    if (argv[index] === "--view") {
      if (simfileArgs.includes("--view")) return fail("Duplicate --view");
      simfileArgs.push("--view");
      index += 1;
      continue;
    }
    for (const flag of values) {
      const parsed = takeValue(argv, index, flag);
      if (parsed === undefined) continue;
      if (simfileArgs.some((arg) => arg === flag || arg.startsWith(`${flag}=`))) {
        return fail(`Duplicate ${flag}`);
      }
      simfileArgs.push(flag, parsed.value);
      index += parsed.consumed;
      matched = true;
      break;
    }
    if (!matched) return fail(`Unknown smoke-run option ${argv[index] ?? ""}`.trim());
  }
  if (context === undefined || !/^[a-z][a-z0-9_-]{0,63}$/u.test(context)) {
    return fail("Smoke run requires --context <safe-local-context>");
  }
  return { baseImage, context, dockerCommand, internalLifecycleSmoke, simfileArgs };
};

const argumentValue = (args: readonly string[], flag: string): string | undefined => {
  const index = args.findIndex((value) => value === flag || value.startsWith(`${flag}=`));
  if (index === -1) return undefined;
  return args[index].startsWith(`${flag}=`) ? args[index].slice(flag.length + 1) : args[index + 1];
};

export const createComposedSmokeInvocation = (
  argv: readonly string[],
  nonce: string = randomUUID()
): Readonly<ComposedSmokeInvocation> => {
  if (!/^[a-f0-9-]{8,64}$/u.test(nonce)) return fail("Composed example nonce is invalid");
  const parsed = parseSmokeRunArguments(argv);
  const example = parsed.internalLifecycleSmoke ? internalSmokeExample : composedExample;
  const runId = argumentValue(parsed.simfileArgs, "--run-id")
    ?? `${parsed.internalLifecycleSmoke ? "composed-lifecycle-smoke" : "jungian-dialogue"}-${nonce}`;
  const out = argumentValue(parsed.simfileArgs, "--out") ?? path.join("runs", runId);
  const simfileArgs = [...parsed.simfileArgs];
  if (argumentValue(simfileArgs, "--run-id") === undefined) simfileArgs.push("--run-id", runId);
  if (argumentValue(simfileArgs, "--out") === undefined) simfileArgs.push("--out", out);
  simfileArgs.push("--context", parsed.context);
  simfileArgs.push("--mode", "lifecycle-replay-smoke");
  const commandArgs = Object.freeze([
    builtCli, "run", example, ...simfileArgs,
  ]);
  return Object.freeze({
    ...parsed,
    command: process.execPath,
    command_args: commandArgs,
    example,
    mode: "lifecycle-replay-smoke",
    out,
    run_id: runId,
    simfileArgs: Object.freeze(simfileArgs),
  });
};

export const runComposedDevelopmentSmoke = async (argv: readonly string[]): Promise<number> => {
  const invocation = createComposedSmokeInvocation(argv);
  const state = await readCurrentState();
  const probe = await probeSpawnfileCapabilities(state.bin);
  if (!probe.composed.ready) {
    return fail(
      `Simfile cannot verify the generic Spawnfile capabilities required for composition (${probe.composed.blockers.join(", ")}); `
      + `Spawnfile ${state.implementation.package_version}, context ${invocation.context}, `
      + `mode ${invocation.mode}, planned output ${invocation.out}`,
    );
  }
  if (state.implementation.package_version !== "0.1.17") {
    return fail("Composed development requires the exact installed Spawnfile 0.1.17 package");
  }
  const environment = {
    ...process.env,
    SPAWNFILE_BIN: state.bin,
    ...(invocation.baseImage === undefined ? {}
      : { SIMFILE_SPAWNFILE_BASE_IMAGE: invocation.baseImage }),
    ...(invocation.dockerCommand === undefined ? {}
      : { SIMFILE_SPAWNFILE_DOCKER_COMMAND: invocation.dockerCommand }),
  };
  const endpoint = await proveSpawnfileLocalEndpoint({
    base_image: invocation.baseImage,
    context: invocation.context,
    cwd: packageRoot,
    docker_command: invocation.dockerCommand,
    env: environment,
    spawnfile_bin: state.bin,
    state_root: path.join(packageRoot, ".simfile-dev", "spawnfile"),
  });
  process.stderr.write(`Spawnfile ${state.implementation.package_version}; local context `
    + `${endpoint.context} (${endpoint.transport}/${endpoint.architecture}); `
    + `run ${invocation.run_id}; output ${invocation.out}\n`);
  const result = await runBoundedProcess(invocation.command, invocation.command_args, {
    allowNonzero: true,
    cwd: packageRoot,
    env: environment,
    timeoutMs: 20 * 60 * 1000,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.code;
};

if (isMainModule(import.meta.url)) {
  try { process.exitCode = await runComposedDevelopmentSmoke(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
