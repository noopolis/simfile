import { parseSpawnfileUpReceipt, type SpawnfileUpReceipt } from "./receipts.js";
import type { SpawnfileCliContext } from "./process.js";
import {
  assertLifecycleInvocation,
  assertSpawnfileAuthProfileName,
  execSpawnfile,
  parseSpawnfileJson,
} from "./spawnfileCliShared.js";

export interface RunSpawnfileUpInput {
  orgPath: string;
  containerName: string;
  deploymentName: string;
  compiledOutputDirectory: string;
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

export const runSpawnfileUp = async (
  context: SpawnfileCliContext,
  input: RunSpawnfileUpInput,
): Promise<SpawnfileUpReceipt> => {
  assertSpawnfileAuthProfileName(input.authProfile);
  const args = ["up", input.orgPath, "--detach", "--name", input.containerName,
    "--deployment", input.deploymentName, "--out", input.compiledOutputDirectory,
    "--tag", input.imageTag, "--context", input.dockerContext,
    "--env-file", input.envFile, "--world-bindings", input.worldBindingsFile,
    "--organization-handoff-run-id", input.organizationHandoffRunId,
    "--descriptor-digest", input.descriptorDigest,
    "--selected-target-receipt", input.selectedTargetReceiptFile,
    "--selected-target-receipt-digest", input.selectedTargetReceiptDigest,
    "--network-attachment-handle", input.networkAttachmentHandle, "--json"];
  if (input.authProfile !== undefined) args.push("--auth-profile", input.authProfile);
  if (input.lifecycleInvocationId !== undefined) {
    assertLifecycleInvocation(input.lifecycleInvocationId);
    args.push("--lifecycle-invocation", input.lifecycleInvocationId);
  }
  const { stdout } = await execSpawnfile(context, args, input.signal);
  return parseSpawnfileUpReceipt(parseSpawnfileJson(stdout));
};
