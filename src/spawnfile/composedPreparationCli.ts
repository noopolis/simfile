import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  parseSpawnfileComposedPreparationRequest,
  verifySpawnfileComposedPreparationReceipt,
  type SpawnfileComposedPreparationReceipt,
  type SpawnfileComposedPreparationRequest,
} from "./preparationReceipt.js";
import type { SpawnfileCliContext } from "./process.js";
import { execSpawnfileWithStdin, parseSpawnfileJson } from "./spawnfileCliShared.js";

export interface RunSpawnfileComposedPreparationInput {
  request: SpawnfileComposedPreparationRequest;
  /** Exact private target configuration bytes; transferred only to child stdin. */
  targetConfigStdin: string | Uint8Array;
  signal?: AbortSignal;
}

/** Invokes Spawnfile's high-level preparation using config bytes only on stdin. */
export const runSpawnfileComposedPreparation = async (
  context: SpawnfileCliContext,
  input: RunSpawnfileComposedPreparationInput,
): Promise<SpawnfileComposedPreparationReceipt> => {
  const request = parseSpawnfileComposedPreparationRequest(input.request);
  const config = typeof input.targetConfigStdin === "string"
    ? new TextEncoder().encode(input.targetConfigStdin)
    : input.targetConfigStdin instanceof Uint8Array
      ? Uint8Array.from(input.targetConfigStdin) : new Uint8Array();
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
      receipt: parseSpawnfileJson(stdout, "composed preparation"), request,
    });
  } finally {
    config.fill(0);
    await rm(root, { force: true, recursive: true });
  }
};
