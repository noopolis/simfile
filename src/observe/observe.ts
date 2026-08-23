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
import { rawBank } from "./rawFiles.js";
import { computeSeedSpread, diffSeedSpreadAgainstLiveMarkerSeen, type SeedSpreadSelfCheck } from "./seedSpread.js";
import {
  readSpreadTranscriptMessages,
  readTickByIngestedMessageId,
  readSpreadMnemeEventsByBank
} from "./seedSpreadArtifacts.js";
import { readWorldEvidence } from "./worldEvidence.js";
import { computeSocialPlane, readSocialTranscript } from "./socialPlane.js";

export interface ObserveResult {
  artifactIntegrity: ArtifactIntegrityCheck[];
  causalParseErrors: { relativePath: string; line: number; message: string }[];
  manifest: SimfileRunManifest;
  report: SimfileObserveReport;
  streams: CausalStreamSource[];
  /** Memetics increment (b): present only when `manifest.seed_declaration`
   * exists — the live-`marker.seen` self-check, diagnostic only (never fed
   * into `report.seed_spread`, see `seedSpread.ts`'s own doc comment). */
  spreadSelfCheck?: SeedSpreadSelfCheck;
}

const loadRunManifest = async (runDir: string): Promise<SimfileRunManifest> => {
  const raw = JSON.parse(await readFile(path.join(runDir, "manifest.json"), "utf8")) as unknown;
  return parseRunManifest(raw);
};

/**
 * Reads a sealed run directory (`manifest.json` + `raw/**\/causal.jsonl` +
 * per-bank `raw/mneme/<bank>/events.jsonl`), reconciles the causal streams
 * with `@noopolis/stele` (no stitching, ever — an incomplete chain is
 * flagged, not synthesized), and emits the `simfile.observe.v1` report.
 * Pure file-reading + reconciliation: no Docker, no compile, no runtime
 * auth (this package's charter, the repository `AGENTS.md`).
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
    const bank = rawBank(stream.relativePath);
    if (!bank) continue;
    eventsByBank.set(bank, [...(eventsByBank.get(bank) ?? []), ...stream.events]);
  }
  const memoryBanks = await collectMemoryBankCounts(runDir, eventsByBank);

  let seedSpread: ReturnType<typeof computeSeedSpread> | undefined;
  let spreadSelfCheck: SeedSpreadSelfCheck | undefined;
  if (manifest.seed_declaration) {
    const [transcriptMessages, mnemeEventsByBank, tickByMoltnetMessageId] = await Promise.all([
      readSpreadTranscriptMessages(runDir),
      readSpreadMnemeEventsByBank(runDir),
      readTickByIngestedMessageId(runDir)
    ]);
    const causalEventsById = new Map(allEvents.map((event) => [event.event_id, event] as const));

    seedSpread = computeSeedSpread({
      seedDeclaration: manifest.seed_declaration,
      causalEventsById,
      transcriptMessages,
      causalEventsByBank: eventsByBank,
      mnemeEventsByBank,
      tickByMoltnetMessageId
    });

    const worldEvents = streams.filter((stream) => stream.authority === "world").flatMap((stream) => stream.events);
    spreadSelfCheck = diffSeedSpreadAgainstLiveMarkerSeen(
      worldEvents,
      transcriptMessages,
      manifest.seed_declaration.token_set,
      manifest.seed_declaration.matcher_policy
    );
  }

  const worldEvidenceResult = await readWorldEvidence(runDir, allEvents);
  const socialPlane = computeSocialPlane(await readSocialTranscript(runDir), allEvents);
  const report = buildObserveReport({ allEvents, manifest, memoryBanks, reconciled, seedSpread, worldEvidence: worldEvidenceResult.evidence, socialPlane });

  return {
    artifactIntegrity,
    causalParseErrors: [...causalParseErrors, ...worldEvidenceResult.parseErrors],
    manifest,
    report,
    streams,
    spreadSelfCheck
  };
};

/** Writes `observe/report.json` under the run directory; returns its path. */
export const writeObserveReport = async (runDir: string, report: SimfileObserveReport): Promise<string> => {
  const observeDir = path.join(runDir, "observe");
  await mkdir(observeDir, { recursive: true });
  const reportPath = path.join(observeDir, "report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return reportPath;
};
