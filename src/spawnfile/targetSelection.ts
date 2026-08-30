import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import { canonicalComposedJson } from "../compose/json.js";
import { runSpawnfileProcess, type BootstrapSpawnfileCliContext } from "./process.js";

const selectedTarget = z.object({
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{32}$/u),
  handle: z.string().regex(/^opaque_[a-z0-9]{16,64}$/u),
  version: z.literal("spawnfile.target-resource.selected-target.v1"),
}).strict();
export type SpawnfileSelectedTarget = z.infer<typeof selectedTarget>;
export const parseSpawnfileSelectedTarget = (raw: unknown): SpawnfileSelectedTarget =>
  Object.freeze(selectedTarget.parse(raw));

export const runSpawnfileSelectTarget = async (input: Readonly<{
  context: BootstrapSpawnfileCliContext;
  request: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
  target_config: Uint8Array;
}>): Promise<SpawnfileSelectedTarget> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simfile-target-select-"));
  const config = Uint8Array.from(input.target_config);
  if (config.byteLength < 1 || config.byteLength > 262_144) {
    throw new TypeError("Spawnfile target configuration is invalid");
  }
  try {
    const request = path.join(root, "request.json");
    await writeFile(request, canonicalComposedJson(input.request), { mode: 0o600 });
    const result = await runSpawnfileProcess(input.context, {
      args: ["target", "--config", "-", "select_target", request],
      signal: input.signal,
      stdin: config,
    });
    return parseSpawnfileSelectedTarget(JSON.parse(result.stdout) as unknown);
  } finally {
    config.fill(0);
    await rm(root, { force: true, recursive: true });
  }
};
