import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  parseSpawnfileDownReceipt,
  parseSpawnfileExportResult,
  parseSpawnfileUpReceipt,
  type SpawnfileDownReceipt,
  type SpawnfileExportResult,
  type SpawnfileUpReceipt
} from "./receipts.js";
import {
  parseSpawnfileComposedPreparationRequest,
  verifySpawnfileComposedPreparationReceipt,
  type SpawnfileComposedPreparationReceipt,
  type SpawnfileComposedPreparationRequest
} from "./preparationReceipt.js";
import { assertSecretFreeComposedJson } from "../compose/json.js";
import {
  runSpawnfileProcess,
  type SpawnfileCliContext,
} from "./process.js";

export type { SpawnfileCliContext } from "./process.js";
const AUTH_PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export const assertSpawnfileAuthProfileName = (
  value: string | undefined
): void => {
  if (value !== undefined && !AUTH_PROFILE_NAME.test(value)) {
    throw new Error("spawnfile auth profile name is not a safe identifier");
  }
};

/**
 * Everything needed to shell the `spawnfile` CLI as a subprocess — the ONLY
 * sanctioned way this package talks to Spawnfile (contracts.md's CLI rule:
 * "simfile -> spawnfile only through documented CLI + versioned receipts").
 * `spawnfileBin` is a path to spawnfile's built `dist/cli/index.js` (or any
 * equivalent entrypoint script); it is always invoked as `node <spawnfileBin>
 * <args>` rather than executed directly, so no `chmod +x`/shebang resolution
 * is required of the caller.
 */
const execSpawnfileWithStdin = (
  context: SpawnfileCliContext,
  args: readonly string[],
  stdin: Uint8Array,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> => runSpawnfileProcess(context, {
  args, signal, stdin,
});

const parseComposedPreparationStdout = (stdout: string): unknown => {
  try {
    return JSON.parse(stdout.trim()) as unknown;
  } catch {
    throw new Error("spawnfile composed preparation did not emit valid JSON");
  }
};

export interface RunSpawnfileComposedPreparationInput {
  request: SpawnfileComposedPreparationRequest;
  /** Exact private target configuration bytes; transferred only to child stdin. */
  targetConfigStdin: string | Uint8Array;
  signal?: AbortSignal;
}

/** Invokes Spawnfile's sole high-level preparation operation. The request file
 * is secret-free and temporary; private target configuration is stdin-only. */
export const runSpawnfileComposedPreparation = async (
  context: SpawnfileCliContext,
  input: RunSpawnfileComposedPreparationInput
): Promise<SpawnfileComposedPreparationReceipt> => {
  const request = parseSpawnfileComposedPreparationRequest(input.request);
  const config = typeof input.targetConfigStdin === "string"
    ? new TextEncoder().encode(input.targetConfigStdin)
    : input.targetConfigStdin instanceof Uint8Array
      ? Uint8Array.from(input.targetConfigStdin)
      : new Uint8Array();
  if (config.byteLength < 1 || config.byteLength > 262_144) {
    throw new Error("spawnfile target configuration stdin is invalid");
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "simfile-spawnfile-prepare-"));
  try {
    const requestFile = path.join(root, "request.json");
    await writeFile(requestFile, `${JSON.stringify(request)}\n`, { mode: 0o600 });
    const { stdout } = await execSpawnfileWithStdin(context, [
      "target", "--config", "-", "prepare_composed_run", requestFile,
    ], config, input.signal);
    return verifySpawnfileComposedPreparationReceipt({
      receipt: parseComposedPreparationStdout(stdout),
      request
    });
  } finally {
    config.fill(0);
    await rm(root, { force: true, recursive: true });
  }
};

const execSpawnfile = async (
  context: SpawnfileCliContext,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> => runSpawnfileProcess(context, { args, signal });

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
  /** Named host auth profile only; never a credential or persisted secret. */
  authProfile?: string;
  descriptorDigest: string;
  dockerContext: string;
  envFile: string;
  imageTag: string;
  lifecycleInvocationId?: string;
  networkAttachmentHandle: string;
  organizationHandoffRunId: string;
  selectedTargetReceiptDigest: string;
  selectedTargetReceiptFile: string;
  signal?: AbortSignal;
  worldBindingsFile: string;
}

/** Shells `spawnfile up <org> --detach --name <container> --deployment <name>
 * --out <compiled> --json`, detached, and parses the `spawnfile.up-receipt.v1`
 * (run_id, moltnet base url, per-agent engine disclosure). */
export const runSpawnfileUp = async (
  context: SpawnfileCliContext,
  input: RunSpawnfileUpInput
): Promise<SpawnfileUpReceipt> => {
  assertSpawnfileAuthProfileName(input.authProfile);
  const args = [
    "up",
    input.orgPath,
    "--detach",
    "--name",
    input.containerName,
    "--deployment",
    input.deploymentName,
    "--out",
    input.compiledOutputDirectory,
    "--tag",
    input.imageTag,
    "--context",
    input.dockerContext,
    "--env-file",
    input.envFile,
    "--world-bindings",
    input.worldBindingsFile,
    "--organization-handoff-run-id",
    input.organizationHandoffRunId,
    "--descriptor-digest",
    input.descriptorDigest,
    "--selected-target-receipt",
    input.selectedTargetReceiptFile,
    "--selected-target-receipt-digest",
    input.selectedTargetReceiptDigest,
    "--network-attachment-handle",
    input.networkAttachmentHandle,
    "--json"
  ];
  if (input.authProfile !== undefined) {
    args.push("--auth-profile", input.authProfile);
  }
  if (input.lifecycleInvocationId !== undefined) {
    assertLifecycleInvocation(input.lifecycleInvocationId);
    args.push("--lifecycle-invocation", input.lifecycleInvocationId);
  }
  const { stdout } = await execSpawnfile(context, args, input.signal);
  return parseSpawnfileUpReceipt(parseTrailingJson(stdout));
};

export interface RunSpawnfileArtifactsExportInput {
  orgPath: string;
  deploymentName: string;
  compiledOutputDirectory: string;
  destinationDirectory: string;
  lifecycleInvocationId?: string;
  signal?: AbortSignal;
}

const assertLifecycleInvocation = (value: string): void => {
  if (!/^lci_[a-z0-9][a-z0-9_-]{15,127}$/u.test(value)) {
    throw new Error("spawnfile lifecycle invocation id is invalid");
  }
};

/** Shells `spawnfile artifacts export <org> --deployment <name> --compiled
 * <compiled> --out <dest> --json`, run BEFORE `spawnfile down` (Decision 21's
 * export-before-teardown discipline). Lands `raw/{moltnet,mneme,daimon}/...`
 * directly under `destinationDirectory` plus `spawnfile/export-index.json`. */
export const runSpawnfileArtifactsExport = async (
  context: SpawnfileCliContext,
  input: RunSpawnfileArtifactsExportInput
): Promise<SpawnfileExportResult> => {
  if (input.lifecycleInvocationId !== undefined
    && !/^lci_[a-z0-9][a-z0-9_-]{15,127}$/u.test(input.lifecycleInvocationId)) {
    throw new Error("spawnfile lifecycle invocation id is invalid");
  }
  const args = [
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
  ];
  if (input.lifecycleInvocationId !== undefined) {
    args.push("--lifecycle-invocation", input.lifecycleInvocationId);
  }
  const { stdout } = await execSpawnfile(context, args, input.signal);
  return parseSpawnfileExportResult(parseTrailingJson(stdout));
};

export interface RunSpawnfileDownInput {
  orgPath: string;
  deploymentName: string;
  compiledOutputDirectory: string;
  lifecycleInvocationId?: string;
  removeVolumes?: boolean;
  signal?: AbortSignal;
}

/** Shells `spawnfile down <org> --deployment <name> --compiled <compiled>
 * --json`, run AFTER artifacts export. Never passes `--force`: a run whose
 * export failed should fail loudly here rather than silently discard
 * artifacts (the export-before-teardown invariant, `src/deployment/AGENTS.md`). */
export const runSpawnfileDown = async (
  context: SpawnfileCliContext,
  input: RunSpawnfileDownInput
): Promise<SpawnfileDownReceipt> => {
  if (input.lifecycleInvocationId !== undefined
    && !/^lci_[a-z0-9][a-z0-9_-]{15,127}$/u.test(input.lifecycleInvocationId)) {
    throw new Error("spawnfile lifecycle invocation id is invalid");
  }
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
  if (input.lifecycleInvocationId !== undefined) {
    args.push("--lifecycle-invocation", input.lifecycleInvocationId);
  }
  const { stdout } = await execSpawnfile(context, args, input.signal);
  return parseSpawnfileDownReceipt(parseTrailingJson(stdout));
};

const targetCommand = /^(?:attach_organization|cleanup_run|create_world_service|detach_organization|export_evidence_volume|query_world_clock|query_world_readiness|revoke_secret_bindings|snapshot_public_artifact|start_world_service|stop_world_service|attest_topology|activate_topology)$/u;

/** Invokes one documented public target operation using an operator-owned config path. */
export const runSpawnfileTargetCommand = async (
  context: SpawnfileCliContext,
  input: Readonly<{
    command: string;
    request: unknown;
    signal?: AbortSignal;
    targetConfigStdin: string | Uint8Array;
  }>,
): Promise<unknown> => {
  if (!targetCommand.test(input.command)) {
    throw new Error("spawnfile target command input is invalid");
  }
  assertSecretFreeComposedJson(input.request);
  const config = typeof input.targetConfigStdin === "string"
    ? new TextEncoder().encode(input.targetConfigStdin)
    : Uint8Array.from(input.targetConfigStdin);
  if (config.byteLength < 1 || config.byteLength > 262_144) {
    throw new Error("spawnfile target configuration stdin is invalid");
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "simfile-spawnfile-target-"));
  try {
    const requestFile = path.join(root, "request.json");
    await writeFile(requestFile, `${JSON.stringify(input.request)}\n`, { mode: 0o600 });
    const { stdout } = await execSpawnfileWithStdin(context, [
      "target", "--config", "-", input.command, requestFile,
    ], config, input.signal);
    return parseTrailingJson(stdout);
  } finally {
    config.fill(0);
    await rm(root, { force: true, recursive: true });
  }
};
