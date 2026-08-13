import { readFile } from "node:fs/promises";
import path from "node:path";

import { findRunRawFiles, rawBank } from "../observe/rawFiles.js";
import type { EngineEntry } from "./engineProvenance.js";
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
  const byBank = new Map<string, RawMnemeEvent[]>();
  const files = (await findRunRawFiles(runDir)).filter(({ rawRelativePath }) => {
    const segments = rawRelativePath.split(path.sep);
    return segments.length === 4 && segments[0] === "raw"
      && segments[1] === "mneme" && segments[3] === "events.jsonl";
  });
  for (const file of files) {
    const bank = rawBank(file.rawRelativePath)!;
    const events = parseJsonlLines(await readFile(file.absolutePath, "utf8")) as RawMnemeEvent[];
    byBank.set(bank, [...(byBank.get(bank) ?? []), ...events]);
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
  const files = (await findRunRawFiles(runDir)).filter(({ rawRelativePath }) => {
    const segments = rawRelativePath.split(path.sep);
    return segments[0] === "raw" && segments[1] === "moltnet"
      && (segments.length === 3 || segments.length === 4)
      && segments.at(-1) === "transcript.json";
  });

  let seedMessageText: string | undefined;
  const merged: RawTranscriptMessage[] = [];
  for (const file of files) {
    const text = await readFile(file.absolutePath, "utf8");
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
  samples: {
    tick: number;
    sim_time: number;
    phase?: string;
    variables: Record<string, number>;
    occupancy?: unknown;
    transit?: unknown;
  }[];
  version: string;
}

const telemetryOccupancy = (value: unknown): Record<string, string[]> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every(([, agents]) => Array.isArray(agents) && agents.every((agent) => typeof agent === "string"))) {
    return undefined;
  }
  return Object.fromEntries(entries.map(([place, agents]) => [place, [...(agents as string[])]]));
};

const telemetryTransit = (value: unknown): RunTelemetrySample["transit"] => {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((entry): entry is { agent: string; from: string; to: string; ticksRemaining: number } =>
    typeof entry === "object" && entry !== null
    && typeof (entry as { agent?: unknown }).agent === "string"
    && typeof (entry as { from?: unknown }).from === "string"
    && typeof (entry as { to?: unknown }).to === "string"
    && typeof (entry as { ticksRemaining?: unknown }).ticksRemaining === "number"
  );
  return entries.length === value.length ? entries : undefined;
};

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
    return parsed.samples.map((sample) => {
      const occupancy = telemetryOccupancy(sample.occupancy);
      const transit = telemetryTransit(sample.transit);
      return {
        tick: sample.tick,
        simTime: sample.sim_time,
        phase: sample.phase,
        variables: sample.variables ?? {},
        ...(occupancy ? { occupancy } : {}),
        ...(transit ? { transit } : {}),
      };
    });
  } catch {
    return null;
  }
};

/** `true` when at least one sample carries at least one variable — the gate that decides whether a run has real gauge data to render (`RunViewModel.variableSamples`'s own doc comment: never a fabricated empty gauge). */
export const hasVariableSamples = (samples: readonly RunTelemetrySample[] | null): boolean =>
  samples !== null && samples.some((sample) => Object.keys(sample.variables).length > 0);

/**
 * Reads `spawnfile/up-receipt.json`'s `engines[]` (per-agent engine
 * breakdown) when a composed run-dir carries one. Loosely shaped, not
 * schema-validated — this is an optional, best-effort finer-grained signal
 * layered on top of the manifest's own single `engine` field, so a
 * malformed/partial file degrades to `undefined` (the caller falls back to
 * `manifest.engine`) rather than throwing. No run-dir currently ships this
 * file, but the neutral `spawnfile/receipts.ts` up-receipt schema
 * already carries `engines` when a real deployment reports mixed per-agent
 * engines, so this reads it the moment one does.
 */
export const readUpReceiptEngines = async (runDir: string): Promise<EngineEntry[] | undefined> => {
  const raw = await readFile(path.join(runDir, "spawnfile", "up-receipt.json"), "utf8").catch(() => null);
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw) as { engines?: unknown };
    if (!Array.isArray(parsed.engines)) return undefined;
    const entries = parsed.engines.filter(
      (entry): entry is EngineEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { engine?: unknown }).engine === "string" &&
        (entry as { engine: string }).engine.length > 0 &&
        (typeof (entry as { agent?: unknown }).agent === "string" || (entry as { agent?: unknown }).agent === undefined)
    );
    return entries.length > 0 ? entries : undefined;
  } catch {
    return undefined;
  }
};
