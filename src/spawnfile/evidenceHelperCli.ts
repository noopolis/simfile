import { z } from "zod";

import { runSpawnfileProcess, type BootstrapSpawnfileCliContext } from "./process.js";

const receipt = z.object({
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  handle: z.string().regex(/^opaque_[a-f0-9]{64}$/u),
  version: z.literal("spawnfile.target-evidence-export-helper.prepared.v1"),
}).strict();

export type SpawnfilePreparedEvidenceHelper = z.infer<typeof receipt>;

/** Invokes the dedicated helper command whose executor supports tar stdin. */
export const runSpawnfilePrepareEvidenceHelper = async (input: Readonly<{
  base_image: string;
  context: BootstrapSpawnfileCliContext;
  docker_command: string;
  local_context: string;
  signal?: AbortSignal;
}>): Promise<SpawnfilePreparedEvidenceHelper> => {
  const args = ["helper", "prepare-evidence-export", "--context", input.local_context,
    "--timeout-ms", "120000", "--json"];
  if (input.base_image !== "node:22-bookworm-slim") {
    args.push("--base-image", input.base_image);
  }
  if (input.docker_command !== "docker") {
    args.push("--docker-command", input.docker_command);
  }
  const result = await runSpawnfileProcess({ ...input.context, timeoutMs: 180_000 }, {
    args, signal: input.signal,
  });
  try { return Object.freeze(receipt.parse(JSON.parse(result.stdout) as unknown)); }
  catch { throw new TypeError("Spawnfile evidence helper receipt is invalid"); }
};
