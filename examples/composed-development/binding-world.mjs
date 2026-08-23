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
export const terminalTick = 4;
export const worldInstanceId = "composed-development-world";

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
  resolveParticipant: (principal) => principal === "agent:smoke" ? "smoke" : undefined,
  resolvePrincipal: (participant) => participant === "smoke" ? "agent:smoke" : undefined,
});

export const loadKernel = async (runId, seed) => {
  const parsed = parseSimfileSource(await readFile(exampleSimfile, "utf8"), {
    path: exampleSimfile,
  });
  if (parsed.simfile.world === undefined) {
    throw new TypeError("composed development world declaration is missing");
  }
  const session = await loadDynamicsSession(parsed.simfile, { seed, simfilePath: exampleSimfile });
  if (session === undefined) {
    throw new TypeError("composed development dynamics declaration is missing");
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
    throw new TypeError("composed development replay accepts no recorded actions");
  },
  async finish(state) {
    const remaining = terminalTick - state.session.nextTick;
    if (!Number.isSafeInteger(remaining) || remaining < 0) {
      throw new TypeError("composed development replay starts beyond its terminal tick");
    }
    for (let step = 0; step < remaining; step += 1) {
      const before = state.session.nextTick;
      state.session.step();
      if (state.session.nextTick !== before + 1) {
        throw new TypeError("composed development replay made invalid tick progress");
      }
    }
    if (state.session.nextTick !== terminalTick) {
      throw new TypeError("composed development replay exceeded its terminal tick");
    }
    return Object.freeze({ probe: probeBytes(runId, terminalTick),
      terminal_state: terminalStateBytes(state.session.snapshot()), terminal_tick: terminalTick });
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
