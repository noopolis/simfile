import { runObserve } from "../observe/index.js";
import { computeMinds, computeProvenance, computeThread, computeVerdict } from "./runViewModelCompute.js";
import { readMnemeEventsByBank, readTranscript } from "./runRawArtifacts.js";
import type { RunViewModel } from "./runViewModelTypes.js";

const stringField = (world: Record<string, unknown>, key: string): string | undefined => {
  const value = world[key];
  return typeof value === "string" ? value : undefined;
};

/**
 * Loads a sealed compose-and-observe run directory and builds the single
 * `RunViewModel` the run-reader page (`runPage.ts`) renders: reconciles the
 * causal streams via the existing `runObserve` (Slice B pipeline, never
 * re-implemented here), reads the raw moltnet transcript for message text,
 * and reads each mneme bank's `events.jsonl` for the per-agent memory
 * portals. Pure orchestration — every field this returns traces back to one
 * of those three already-audited sources (`observe/AGENTS.md`,
 * `VIEW_DESIGN.md` rule 2: observer tier only, no invented state).
 */
export const buildRunViewModel = async (runDir: string): Promise<RunViewModel> => {
  const observed = await runObserve(runDir);
  const transcript = await readTranscript(runDir);
  const mnemeEventsByBank = await readMnemeEventsByBank(runDir);
  const allEvents = observed.streams.flatMap((stream) => stream.events);

  const world = observed.manifest.world;
  const members = world?.members;

  return {
    version: "simfile.run-view-model.v1",
    runId: observed.manifest.run_id,
    createdAt: observed.manifest.created_at,
    engine: observed.manifest.engine,
    world: world
      ? {
          networkId: stringField(world, "network_id"),
          roomId: stringField(world, "room_id"),
          members: Array.isArray(members)
            ? members.filter((member): member is string => typeof member === "string")
            : undefined
        }
      : undefined,
    participants: observed.report.participants,
    verdict: computeVerdict(observed.report, observed.artifactIntegrity),
    thread: computeThread(transcript, allEvents, mnemeEventsByBank),
    minds: computeMinds(mnemeEventsByBank),
    provenance: computeProvenance(observed.manifest, observed.report, observed.artifactIntegrity)
  };
};
