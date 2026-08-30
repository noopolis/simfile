import { z } from "zod";

import { runSpawnfileProcess, type BootstrapSpawnfileCliContext } from "./process.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const context = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
export const SPAWNFILE_TARGET_DOCKER_TIMEOUT_MS = 120_000;
const preview = z.object({
  base_image: z.object({ config_digest: digest,
    reference: z.string().min(1).max(512) }).strict(),
  context_selection: z.literal("explicit"),
  endpoint: z.object({ class: z.literal("local"),
    transport: z.enum(["fd", "npipe", "unix"]) }).strict(),
  platform: z.object({ architecture: z.enum(["amd64", "arm64"]),
    os: z.literal("linux") }).strict(),
  target_config: z.object({ context,
    version: z.literal("spawnfile.target-default-config.v1") }).passthrough(),
  target_config_digest: digest,
  version: z.literal("spawnfile.target-config-resolution.v1"),
}).strict();

export type SpawnfileTargetConfigPreview = Readonly<{
  base_image: Readonly<{ config_digest: `sha256:${string}`; reference: string }>;
  context: string;
  endpoint_transport: "fd" | "npipe" | "unix";
  platform: Readonly<{ architecture: "amd64" | "arm64"; os: "linux" }>;
}>;

export const runSpawnfileTargetConfigPreview = async (input: Readonly<{
  base_image: string;
  context: BootstrapSpawnfileCliContext;
  docker_command: string;
  evidence_destination: string;
  local_context: string;
  signal?: AbortSignal;
}>): Promise<SpawnfileTargetConfigPreview> => {
  const args = ["target", "resolve_config", "--context", input.local_context,
    "--evidence-destination", input.evidence_destination,
    "--timeout-ms", String(SPAWNFILE_TARGET_DOCKER_TIMEOUT_MS)];
  if (input.base_image !== "node:22-bookworm-slim") args.push("--base-image", input.base_image);
  if (input.docker_command !== "docker") args.push("--docker-command", input.docker_command);
  const result = preview.parse(JSON.parse((await runSpawnfileProcess(input.context, {
    args, signal: input.signal,
  })).stdout) as unknown);
  if (result.target_config.context !== input.local_context) {
    throw new TypeError("Spawnfile target preview context changed");
  }
  return Object.freeze({
    base_image: Object.freeze({ ...result.base_image }) as SpawnfileTargetConfigPreview["base_image"],
    context: input.local_context,
    endpoint_transport: result.endpoint.transport,
    platform: Object.freeze(result.platform),
  });
};
