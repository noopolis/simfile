import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  parseSpawnfileDownReceipt,
  parseSpawnfileExportResult,
  parseSpawnfileUpReceipt,
  type SpawnfileDownReceipt,
  type SpawnfileExportResult,
  type SpawnfileUpReceipt
} from "./spawnfileReceipts.js";

const execFileAsync = promisify(execFile);

/** 64MB — generous headroom for a `docker build`'s buildkit progress stream,
 * which lands on stderr (verified: `spawnfile up --json`'s ONLY stdout write
 * is the final receipt; docker build/run output is inherited to stderr, see
 * `src/compiler/buildProject.ts`/`runProjectDocker.ts`). Stdout itself is
 * always small (one JSON receipt), so this only bounds stderr capture. */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * Everything needed to shell the `spawnfile` CLI as a subprocess — the ONLY
 * sanctioned way this package talks to Spawnfile (contracts.md's CLI rule:
 * "simfile -> spawnfile only through documented CLI + versioned receipts").
 * `spawnfileBin` is a path to spawnfile's built `dist/cli/index.js` (or any
 * equivalent entrypoint script); it is always invoked as `node <spawnfileBin>
 * <args>` rather than executed directly, so no `chmod +x`/shebang resolution
 * is required of the caller.
 */
export interface SpawnfileCliContext {
  spawnfileBin: string;
  nodeBin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const execSpawnfile = async (
  context: SpawnfileCliContext,
  args: readonly string[]
): Promise<{ stdout: string; stderr: string }> => {
  const nodeBin = context.nodeBin ?? process.execPath;
  try {
    return await execFileAsync(nodeBin, [context.spawnfileBin, ...args], {
      cwd: context.cwd,
      env: context.env ?? process.env,
      maxBuffer: MAX_BUFFER_BYTES
    });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `spawnfile ${args.join(" ")} failed: ${message}${stderr ? `\n\n${stderr}` : ""}`
    );
  }
};

const parseTrailingJson = (stdout: string): unknown => {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `spawnfile CLI did not print valid JSON on stdout: ${(error as Error).message}\n\n${trimmed}`
    );
  }
};

export interface RunSpawnfileUpInput {
  orgPath: string;
  containerName: string;
  deploymentName: string;
  compiledOutputDirectory: string;
}

/** Shells `spawnfile up <org> --detach --name <container> --deployment <name>
 * --out <compiled> --json`, detached, and parses the `spawnfile.up-receipt.v1`
 * (run_id, moltnet base url, per-agent engine disclosure). */
export const runSpawnfileUp = async (
  context: SpawnfileCliContext,
  input: RunSpawnfileUpInput
): Promise<SpawnfileUpReceipt> => {
  const { stdout } = await execSpawnfile(context, [
    "up",
    input.orgPath,
    "--detach",
    "--name",
    input.containerName,
    "--deployment",
    input.deploymentName,
    "--out",
    input.compiledOutputDirectory,
    "--json"
  ]);
  return parseSpawnfileUpReceipt(parseTrailingJson(stdout));
};

export interface RunSpawnfileArtifactsExportInput {
  orgPath: string;
  deploymentName: string;
  compiledOutputDirectory: string;
  destinationDirectory: string;
}

/** Shells `spawnfile artifacts export <org> --deployment <name> --compiled
 * <compiled> --out <dest> --json`, run BEFORE `spawnfile down` (Decision 21's
 * export-before-teardown discipline). Lands `raw/{moltnet,mneme,daimon}/...`
 * directly under `destinationDirectory` plus `spawnfile/export-index.json`. */
export const runSpawnfileArtifactsExport = async (
  context: SpawnfileCliContext,
  input: RunSpawnfileArtifactsExportInput
): Promise<SpawnfileExportResult> => {
  const { stdout } = await execSpawnfile(context, [
    "artifacts",
    "export",
    input.orgPath,
    "--deployment",
    input.deploymentName,
    "--compiled",
    input.compiledOutputDirectory,
    "--out",
    input.destinationDirectory,
    "--json"
  ]);
  return parseSpawnfileExportResult(parseTrailingJson(stdout));
};

export interface RunSpawnfileDownInput {
  orgPath: string;
  deploymentName: string;
  compiledOutputDirectory: string;
  removeVolumes?: boolean;
}

/** Shells `spawnfile down <org> --deployment <name> --compiled <compiled>
 * --json`, run AFTER artifacts export. Never passes `--force`: a run whose
 * export failed should fail loudly here rather than silently discard
 * artifacts (the export-before-teardown invariant, `src/deployment/AGENTS.md`). */
export const runSpawnfileDown = async (
  context: SpawnfileCliContext,
  input: RunSpawnfileDownInput
): Promise<SpawnfileDownReceipt> => {
  const args = [
    "down",
    input.orgPath,
    "--deployment",
    input.deploymentName,
    "--compiled",
    input.compiledOutputDirectory,
    "--json"
  ];
  if (input.removeVolumes) args.push("--volumes");
  const { stdout } = await execSpawnfile(context, args);
  return parseSpawnfileDownReceipt(parseTrailingJson(stdout));
};
