import { runObserve } from "../observe/index.js";
import { computeEngineProvenance, decisionSourceFromUnknown, type EngineEntry } from "./engineProvenance.js";
import { computeMinds, computeProvenance, computeThread, computeVerdict } from "./runViewModelCompute.js";
import {
  hasVariableSamples,
  readMnemeEventsByBank,
  readTranscript,
  readUpReceiptEngines,
  readWorldTelemetry
} from "./runRawArtifacts.js";
import type { RunViewModel } from "./runViewModelTypes.js";

const stringField = (world: Record<string, unknown>, key: string): string | undefined => {
  const value = world[key];
  return typeof value === "string" ? value : undefined;
};

/**
 * Loads a sealed compose-and-observe run directory and builds the single
 * `RunViewModel`: reconciles the causal streams via the existing
 * `runObserve` (Slice B pipeline, never re-implemented here), reads the raw
 * moltnet transcript for message text, and reads each mneme bank's
 * `events.jsonl` for the per-agent memory portals. Pure orchestration —
 * every field this returns traces back to one of those three
 * already-audited sources (`observe/AGENTS.md`, `docs/VIEW_DESIGN.md` rule 2:
 * observer tier only, no invented state). `server.ts`'s `/api/run-meta`
 * serves this model's `verdict`/`provenance` fields to the React shell
 * (`web/src/viewer/RunMetaPanels.tsx`); `thread`/`minds` are computed too
 * but no longer served whole — the shell gets chat/minds content from
 * `/api/timeline` instead. Increment 3 additionally passes through
 * `runObserve`'s own `seed_spread`/`spread_summary` (never recomputed) and,
 * only when the run has a non-empty `world/telemetry.json` variable
 * sample set, that sample set too — also served via `/api/run-meta` for
 * the spread readout and the (seam-only) variable gauge.
 */
export const buildRunViewModel = async (runDir: string): Promise<RunViewModel> => {
  const observed = await runObserve(runDir);
  const transcript = await readTranscript(runDir);
  const mnemeEventsByBank = await readMnemeEventsByBank(runDir);
  const telemetrySamples = await readWorldTelemetry(runDir);
  const upReceiptEngines = await readUpReceiptEngines(runDir);
  const allEvents = observed.streams.flatMap((stream) => stream.events);

  const world = observed.manifest.world;
  const members = world?.members;
  const decisionSource = decisionSourceFromUnknown(world?.decision_source);

  // Prefer the up-receipt's per-agent engines[] (finer-grained, catches a
  // mixed run) when the run-dir has one; otherwise fall back to the
  // manifest's own single collapsed `engine` string, folded to one entry.
  // No engine anywhere at all -> an empty list, which `computeEngineProvenance`
  // reports as `"unknown"` rather than defaulting to real.
  const engineEntries: EngineEntry[] =
    upReceiptEngines ?? (observed.manifest.engine ? [{ engine: observed.manifest.engine }] : []);

  return {
    version: "simfile.run-view-model.v1",
    runId: observed.manifest.run_id,
    createdAt: observed.manifest.created_at,
    engine: observed.manifest.engine,
    engineProvenance: computeEngineProvenance(engineEntries, decisionSource),
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
    provenance: computeProvenance(observed.manifest, observed.report, observed.artifactIntegrity),
    seedSpread: observed.report.seed_spread,
    spreadSummary: observed.report.spread_summary,
    variableSamples: hasVariableSamples(telemetrySamples) ? telemetrySamples! : undefined,
    pace: observed.report.world_evidence?.pace
  };
};
