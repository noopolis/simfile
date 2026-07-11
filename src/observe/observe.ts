import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { reconcileEvents, type CausalEvent } from "@noopolis/stele";

import type { ArtifactIntegrityCheck } from "./artifacts.js";
import { verifyManifestArtifacts } from "./artifacts.js";
import type { CausalStreamSource } from "./causalStreams.js";
import { collectCausalStreams } from "./causalStreams.js";
import { buildObserveReport } from "./compute.js";
import { collectMemoryBankCounts } from "./memoryBanks.js";
import type { SimfileRunManifest } from "./manifest.js";
import { parseRunManifest } from "./manifest.js";
import type { SimfileObserveReport } from "./report.js";

export interface ObserveResult {
  artifactIntegrity: ArtifactIntegrityCheck[];
  causalParseErrors: { relativePath: string; line: number; message: string }[];
  manifest: SimfileRunManifest;
  report: SimfileObserveReport;
  streams: CausalStreamSource[];
}

const loadRunManifest = async (runDir: string): Promise<SimfileRunManifest> => {
  const raw = JSON.parse(await readFile(path.join(runDir, "manifest.json"), "utf8")) as unknown;
  return parseRunManifest(raw);
};

const bankFromRelativePath = (relativePath: string): string | undefined => {
  // raw/mneme/<bank>/causal.jsonl
  const segments = relativePath.split(path.sep);
  return segments[0] === "raw" && segments[1] === "mneme" ? segments[2] : undefined;
};

/**
 * Reads a sealed run directory (`manifest.json` + `raw/**\/causal.jsonl` +
 * per-bank `raw/mneme/<bank>/events.jsonl`), reconciles the causal streams
 * with `@noopolis/stele` (no stitching, ever — an incomplete chain is
 * flagged, not synthesized), and emits the `simfile.observe.v1` report.
 * Pure file-reading + reconciliation: no Docker, no compile, no runtime
 * auth (this package's charter, `ecosystem/simfile/AGENTS.md`).
 */
export const runObserve = async (runDir: string): Promise<ObserveResult> => {
  const manifest = await loadRunManifest(runDir);
  const artifactIntegrity = await verifyManifestArtifacts(runDir, manifest.artifacts);

  const streams = await collectCausalStreams(runDir);
  const causalParseErrors = streams.flatMap((stream) =>
    stream.errors.map((error) => ({ relativePath: stream.relativePath, ...error }))
  );

  const allEvents: CausalEvent[] = streams.flatMap((stream) => stream.events);
  const reconciled = reconcileEvents(allEvents);

  const eventsByBank = new Map<string, CausalEvent[]>();
  for (const stream of streams) {
    const bank = bankFromRelativePath(stream.relativePath);
    if (!bank) continue;
    eventsByBank.set(bank, [...(eventsByBank.get(bank) ?? []), ...stream.events]);
  }
  const memoryBanks = await collectMemoryBankCounts(runDir, eventsByBank);

  const report = buildObserveReport({ allEvents, manifest, memoryBanks, reconciled });

  return { artifactIntegrity, causalParseErrors, manifest, report, streams };
};

/** Writes `observe/report.json` under the run directory; returns its path. */
export const writeObserveReport = async (runDir: string, report: SimfileObserveReport): Promise<string> => {
  const observeDir = path.join(runDir, "observe");
  await mkdir(observeDir, { recursive: true });
  const reportPath = path.join(observeDir, "report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return reportPath;
};
