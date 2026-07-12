import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { RawMnemeEvent, RawTranscript, RawTranscriptMessage, RunTelemetrySample } from "./runViewModelTypes.js";

/**
 * Shared, dependency-free reads of the raw run-directory artifacts every
 * run-reader/run-replay data path needs: the moltnet transcript, the
 * per-bank mneme event logs, and (increment 3) the world telemetry
 * snapshot. Extracted out of `runViewModel.ts` so `runTimeline.ts`
 * (`buildRunTimeline`) can read the exact same records without
 * re-implementing or duplicating file I/O (`AGENTS.md`: small composable
 * modules, no invented state).
 */

const parseJsonlLines = (text: string): unknown[] =>
  text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);

export const readMnemeEventsByBank = async (runDir: string): Promise<Map<string, RawMnemeEvent[]>> => {
  const mnemeDir = path.join(runDir, "raw", "mneme");
  const bankDirs = await readdir(mnemeDir, { withFileTypes: true }).catch(() => []);

  const byBank = new Map<string, RawMnemeEvent[]>();
  for (const entry of bankDirs) {
    if (!entry.isDirectory()) continue;
    const text = await readFile(path.join(mnemeDir, entry.name, "events.jsonl"), "utf8").catch(() => null);
    if (text === null) continue;
    byBank.set(entry.name, parseJsonlLines(text) as RawMnemeEvent[]);
  }
  return byBank;
};

/** The `raw/moltnet/transcript.json` shape written by `moltnet/transcript-export.ts`'s `exportMoltnetTranscript`. */
interface RawTranscriptExportShape {
  version?: string;
  source?: string;
  conversations: { messages: RawTranscriptMessage[] }[];
}

/** The golden-fixture shape (`fixtures/observe/office-sim-golden/raw/moltnet/transcript.json`). */
interface RawTranscriptGoldenShape {
  seedMessageText?: string;
  transcript: RawTranscriptMessage[];
}

const isExportShape = (value: unknown): value is RawTranscriptExportShape =>
  typeof value === "object" && value !== null && Array.isArray((value as { conversations?: unknown }).conversations);

/**
 * Normalizes both `raw/moltnet/transcript.json` shapes into one internal
 * message list: the golden fixture's `{seedMessageText, transcript: [...]}`
 * and a real composed run's export shape `{conversations: [{messages:
 * [...]}] }` (`moltnet/transcript-export.ts`'s `MoltnetExportedTranscript`).
 * Every conversation's messages are flattened and re-sorted by
 * `created_at` so multi-conversation exports still read chronologically;
 * single-conversation runs (the only shape produced today) are a no-op
 * re-sort of an already-ordered list.
 */
export const normalizeRawTranscript = (raw: unknown): RawTranscript => {
  if (isExportShape(raw)) {
    const transcript = raw.conversations
      .flatMap((conversation) => conversation.messages ?? [])
      .slice()
      .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at));
    return { transcript };
  }

  const golden = raw as RawTranscriptGoldenShape;
  return { seedMessageText: golden.seedMessageText, transcript: golden.transcript ?? [] };
};

/**
 * Reads every moltnet transcript in a run-dir and merges them into one
 * chronologically-sorted message list. A single-network run writes the flat
 * `raw/moltnet/transcript.json` (the golden/office-sim shape); a multi-network
 * composed run (the jungian psyche) writes one per network under
 * `raw/moltnet/<network_id>/transcript.json`. Both are read and unioned so the
 * timeline's `messagesById` spans every room across every network — the join
 * an interior-council membrane needs. Message ids are globally-unique UUIDs, so
 * a flat re-sort of the union is a correct chronological interleave.
 */
export const readTranscript = async (runDir: string): Promise<RawTranscript> => {
  const moltnetDir = path.join(runDir, "raw", "moltnet");
  const files: string[] = [path.join(moltnetDir, "transcript.json")];
  const entries = await readdir(moltnetDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) files.push(path.join(moltnetDir, entry.name, "transcript.json"));
  }

  let seedMessageText: string | undefined;
  const merged: RawTranscriptMessage[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8").catch(() => null);
    if (text === null) continue;
    const normalized = normalizeRawTranscript(JSON.parse(text) as unknown);
    if (seedMessageText === undefined && normalized.seedMessageText !== undefined) {
      seedMessageText = normalized.seedMessageText;
    }
    merged.push(...normalized.transcript);
  }

  merged.sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at));
  return { seedMessageText, transcript: merged };
};

/** The `world/telemetry.json` shape written by `src/runtime/run-record.ts`'s `TelemetryArtifact`. */
interface RawTelemetryArtifact {
  run_id: string;
  samples: { tick: number; sim_time: number; phase?: string; variables: Record<string, number> }[];
  version: string;
}

/**
 * Reads `world/telemetry.json` when present (world-driven runs only —
 * `office-secret-v0-golden` ships one, `office-sim-golden` does not).
 * Returns `null` on any missing/malformed file rather than throwing: this
 * artifact is optional, never a requirement for a run to render
 * (`runDetect.ts`'s shape check does not require it).
 */
export const readWorldTelemetry = async (runDir: string): Promise<RunTelemetrySample[] | null> => {
  const raw = await readFile(path.join(runDir, "world", "telemetry.json"), "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as RawTelemetryArtifact;
    if (!Array.isArray(parsed.samples)) return null;
    return parsed.samples.map((sample) => ({
      tick: sample.tick,
      simTime: sample.sim_time,
      phase: sample.phase,
      variables: sample.variables ?? {},
    }));
  } catch {
    return null;
  }
};

/** `true` when at least one sample carries at least one variable — the gate that decides whether a run has real gauge data to render (`RunViewModel.variableSamples`'s own doc comment: never a fabricated empty gauge). */
export const hasVariableSamples = (samples: readonly RunTelemetrySample[] | null): boolean =>
  samples !== null && samples.some((sample) => Object.keys(sample.variables).length > 0);
