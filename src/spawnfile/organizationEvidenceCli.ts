import {
  parseSpawnfileDownReceipt,
  parseSpawnfileExportResult,
  type SpawnfileDownReceipt,
  type SpawnfileExportResult,
} from "./receipts.js";
import type { SpawnfileCliContext } from "./process.js";
import {
  assertLifecycleInvocation,
  execSpawnfile,
  parseSpawnfileJson,
} from "./spawnfileCliShared.js";

export interface RunSpawnfileArtifactsExportInput {
  orgPath: string;
  deploymentName: string;
  compiledOutputDirectory: string;
  destinationDirectory: string;
  lifecycleInvocationId?: string;
  signal?: AbortSignal;
}

export const runSpawnfileArtifactsExport = async (
  context: SpawnfileCliContext,
  input: RunSpawnfileArtifactsExportInput,
): Promise<SpawnfileExportResult> => {
  const args = ["artifacts", "export", input.orgPath,
    "--deployment", input.deploymentName, "--compiled", input.compiledOutputDirectory,
    "--out", input.destinationDirectory, "--json"];
  if (input.lifecycleInvocationId !== undefined) {
    assertLifecycleInvocation(input.lifecycleInvocationId);
    args.push("--lifecycle-invocation", input.lifecycleInvocationId);
  }
  const { stdout } = await execSpawnfile(context, args, input.signal);
  return parseSpawnfileExportResult(parseSpawnfileJson(stdout));
};

export interface RunSpawnfileDownInput {
  orgPath: string;
  deploymentName: string;
  compiledOutputDirectory: string;
  lifecycleInvocationId?: string;
  removeVolumes?: boolean;
  signal?: AbortSignal;
}

export const runSpawnfileDown = async (
  context: SpawnfileCliContext,
  input: RunSpawnfileDownInput,
): Promise<SpawnfileDownReceipt> => {
  const args = ["down", input.orgPath, "--deployment", input.deploymentName,
    "--compiled", input.compiledOutputDirectory, "--json"];
  if (input.removeVolumes) args.push("--volumes");
  if (input.lifecycleInvocationId !== undefined) {
    assertLifecycleInvocation(input.lifecycleInvocationId);
    args.push("--lifecycle-invocation", input.lifecycleInvocationId);
  }
  const { stdout } = await execSpawnfile(context, args, input.signal);
  return parseSpawnfileDownReceipt(parseSpawnfileJson(stdout));
};
