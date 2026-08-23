import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { assertSecretFreeComposedJson } from "../compose/json.js";
import type { SpawnfileCliContext } from "./process.js";
import { execSpawnfileWithStdin, parseSpawnfileJson } from "./spawnfileCliShared.js";

const targetCommand = /^(?:attach_organization|cleanup_run|create_world_service|detach_organization|export_evidence_volume|lookup_operation|query_world_clock|query_world_readiness|recover_operation|revoke_secret_bindings|snapshot_public_artifact|start_world_service|stop_world_service|attest_topology|activate_topology)$/u;

export const runSpawnfileTargetCommand = async (
  context: SpawnfileCliContext,
  input: Readonly<{ command: string; request: unknown; signal?: AbortSignal;
    targetConfigStdin: string | Uint8Array }>,
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
    return parseSpawnfileJson(stdout);
  } finally {
    config.fill(0);
    await rm(root, { force: true, recursive: true });
  }
};
