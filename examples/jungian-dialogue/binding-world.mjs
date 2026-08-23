import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadDynamicsSession } from "simfile/dynamics";
import { parseSimfileSource } from "simfile/schema";
import {
  captureWorldCheckpoint,
  createWorldServiceContract,
} from "simfile/world-artifact";
import {
  composeWorldRuntimeInput,
  createWorldRuntime,
  parseWorldCheckpoint,
} from "simfile/world";
import { parseWorldSurfaceDefinition } from "simfile/world-surface";

import { probeBytes, terminalStateBytes } from "./world/evidence.mjs";
import { createWorldSurfaceDefinition } from "./world/surface.mjs";

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
export const packageRoot = path.resolve(exampleRoot, "../..");
export const exampleSimfile = path.join(exampleRoot, "Simfile");
export const exampleSpawnfile = path.join(exampleRoot, "org", "Spawnfile");
export const terminalTick = 12;
export const worldInstanceId = "jungian-dialogue-world";
export const participants = Object.freeze(["analyst", "daimon"]);

export const serviceContract = createWorldServiceContract({
  adapters: { json: "WorldJsonServer", mcp: "WorldMcpProtocolServer" },
  capability_manifest: "simfile.capability-manifest.v1",
  dynamics_provider: "simfile.dynamics-provider.v1",
  handler: "WorldRequestHandler",
  operations: ["status"],
  spawnfile_receipts: ["spawnfile.target-resource.receipt.v1"],
  world_act_request: "simfile.world-act-request.v1",
  world_bindings: "simfile.world-bindings.v1",
  world_checkpoint: "simfile.world-checkpoint.v1",
  world_runtime: "WorldRuntime",
  world_surface: "simfile.world-surface.v1",
});

const principalResolver = Object.freeze({
  resolveParticipant: (principal) => participants.find(
    (participant) => principal === `agent:${participant}`,
  ),
  resolvePrincipal: (participant) => participants.includes(participant)
    ? `agent:${participant}` : undefined,
});

export const loadKernel = async (runId, seed) => {
  const parsed = parseSimfileSource(await readFile(exampleSimfile, "utf8"), {
    path: exampleSimfile,
  });
  if (parsed.simfile.world === undefined) {
    throw new TypeError("jungian dialogue world declaration is missing");
  }
  const session = await loadDynamicsSession(parsed.simfile, {
    seed, simfilePath: exampleSimfile,
  });
  if (session === undefined) {
    throw new TypeError("jungian dialogue dynamics declaration is missing");
  }
  const runtimeInput = composeWorldRuntimeInput({
    principalResolver, runId, session,
    surfaceRegistry: parseWorldSurfaceDefinition(createWorldSurfaceDefinition()),
    world: parsed.simfile.world, worldInstanceId,
  });
  return { checkpoint: captureWorldCheckpoint(createWorldRuntime(runtimeInput)),
    parsed, runtimeInput, session };
};

export const replayAdapter = (runId, seed) => Object.freeze({
  async restore(rawCheckpoint) {
    const checkpoint = parseWorldCheckpoint(rawCheckpoint);
    const kernel = await loadKernel(runId, seed);
    kernel.session.restore(checkpoint.dynamics);
    return Object.freeze({ session: kernel.session });
  },
  async inject() {
    throw new TypeError("jungian dialogue replay accepts no recorded actions");
  },
  async finish(state) {
    const remaining = terminalTick - state.session.nextTick;
    if (!Number.isSafeInteger(remaining) || remaining < 0) {
      throw new TypeError("jungian dialogue replay starts beyond its terminal tick");
    }
    for (let step = 0; step < remaining; step += 1) state.session.step();
    if (state.session.nextTick !== terminalTick) {
      throw new TypeError("jungian dialogue replay missed its terminal tick");
    }
    return Object.freeze({
      probe: probeBytes(runId, terminalTick),
      terminal_state: terminalStateBytes(state.session.snapshot()),
      terminal_tick: terminalTick,
    });
  },
});

export const evidenceArtifacts = Object.freeze([
  { path: "actions/accepted.json", role: "accepted-action", source: "actions/accepted-strategic-actions.json" },
  { path: "actions/results.jsonl", role: "action-result", source: "actions/results.jsonl" },
  { path: "identity/principals.json", role: "identity", source: "projections/principals.json" },
  { path: "probes/lifecycle-replay.json", role: "probe", source: "projections/lifecycle-replay-probe.json" },
  { path: "replay/accepted-actions.jsonl", role: "accepted-action", source: "actions/replay-accepted-actions.jsonl" },
  { path: "replay/expected.json", role: "terminal", source: "projections/replay-expected.json" },
  { path: "replay/initial-checkpoint.json", role: "world-checkpoint", source: "checkpoints/initial.json" },
  { path: "replay/terminal-checkpoint.json", role: "world-checkpoint", source: "checkpoints/terminal.json" },
  { path: "world/frames.jsonl", role: "world-frame", source: "projections/frames.jsonl" },
  { path: "world/terminal-state.json", role: "provenance", source: "projections/terminal-state.json" },
]);

