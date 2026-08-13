import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import YAML from "yaml";

import {
  evaluateContainmentMarker,
  evaluatePropagationMarker,
  scanMarkers,
  type MarkerCoverageResult
} from "../ledger/markers.js";
import { parseCanonicalLedgerJsonl } from "../ledger/validation.js";
import { evaluateProbe, type ProbeDefinition, type ProbeEvaluationResult } from "../report/probes.js";
import { evaluateTranscriptAcceptance, type TranscriptAcceptanceResult } from "../report/transcripts.js";
import type { Simfile } from "../schema/model.js";
import { emptyProjectViewerExtensionsBytes } from "../viewer-extension/projectDeclaration.js";
import { serializeCanonicalEvents } from "./trace-export.js";
import { runSimfileTrace } from "./trace-run.js";
import type { QueuedWorldAct, RuntimeTrace, RuntimeVariableSample, WorldActResult } from "./types.js";
import { buildViewerTrace, type ViewerContractTrace } from "./viewer-trace.js";

// Re-exported so the `emit-causal-fixture` npm script (B92's real entry
// point into simfile) has a single, stable import surface next to the rest
// of run-record's artifact-writing API. See causal-fixture.ts for the
// noopolis.causal-event.v1 wire mapping.
export { buildCausalFixtureRecords, toCausalFixtureRecord, type CausalFixtureRecord } from "./causal-fixture.js";

export interface RunRecordOptions {
  moltnetArtifact?: MoltnetArtifactKind;
  outDir: string;
  precision?: number;
  runId: string;
  seed: string;
  simfile: Simfile;
  sourcePath: string;
  sourceText: string;
  ticks: number;
  worldActs?: readonly QueuedWorldAct[];
  viewerExtensionsBytes?: Uint8Array;
}

export interface RunReport {
  markers: MarkerCoverageResult[];
  moltnet?: {
    transcript?: TranscriptAcceptanceResult;
  };
  probes: ProbeEvaluationResult[];
  run_id: string;
  seed: string;
  ticks: number;
  world_acts: WorldActResult[];
}

export interface TelemetryArtifact {
  run_id: string;
  samples: RuntimeVariableSample[];
  snapshot_every?: number;
  version: "simfile.telemetry.v1";
}

export type MoltnetArtifactKind = "delivery" | "transcript";

export interface MoltnetArtifactEntry {
  event_id: string;
  kind: "world.dm" | "world.message";
  marker_ids: string[];
  rule_id?: string;
  scope: string;
  sim_time: number;
  target: string;
  text?: string;
}

export interface MoltnetTranscriptArtifact {
  source: "harness-derived";
  entries: MoltnetArtifactEntry[];
  run_id: string;
  version: "simfile.moltnet.transcript.v1";
}

export interface MoltnetDeliveryArtifact {
  source: "harness-derived";
  deliveries: MoltnetArtifactEntry[];
  run_id: string;
  version: "simfile.moltnet.delivery.v1";
}

export interface RunRecordResult {
  ledgerPath: string;
  manifestPath: string;
  moltnetArtifactPath?: string;
  outDir: string;
  report: RunReport;
  reportPath: string;
  telemetryPath: string;
  trace: RuntimeTrace;
  viewerTrace: ViewerContractTrace;
  viewerTracePath: string;
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const evaluateMarkers = (simfile: Simfile, trace: RuntimeTrace): MarkerCoverageResult[] => {
  const hits = scanMarkers(trace.events, simfile.markers);
  return Object.entries(simfile.markers).map(([markerId, marker]) => {
    const markerHits = hits[markerId] ?? [];
    return marker.mode === "containment"
      ? evaluateContainmentMarker(markerId, marker, markerHits)
      : evaluatePropagationMarker(markerId, marker, markerHits);
  });
};

const evaluateProbes = (simfile: Simfile, trace: RuntimeTrace): ProbeEvaluationResult[] =>
  Object.entries(simfile.probes).map(([probeId, probe]) =>
    evaluateProbe(probeId, { events: trace.events, samples: trace.samples }, probe as ProbeDefinition)
  );

const manifestFor = (options: RunRecordOptions): Record<string, unknown> => {
  const artifacts: Record<string, string> = {
    ledger: "ledger.jsonl",
    report: "report.json",
    telemetry: "telemetry.json",
    viewer_extensions: "viewer-extensions.json",
    viewer_trace: "viewer-trace.json"
  };

  if (options.moltnetArtifact) {
    artifacts.moltnet = `moltnet-${options.moltnetArtifact}.json`;
  }

  return {
    simfile_version: options.simfile.simfile_version,
    run_id: options.runId,
    run_name: options.simfile.name,
    seed: options.seed,
    ticks: options.ticks,
    source: {
      path: options.sourcePath,
      sha256: sha256(options.sourceText)
    },
    artifacts
  };
};

const telemetryFor = (simfile: Simfile, trace: RuntimeTrace): TelemetryArtifact => {
  const snapshotEvery = simfile.telemetry?.snapshot_every;
  const samples = snapshotEvery === undefined
    ? trace.samples
    : trace.samples.filter((sample, index) =>
      index === trace.samples.length - 1 || sample.tick % snapshotEvery === 0
    );
  return {
    run_id: trace.runId,
    samples,
    snapshot_every: snapshotEvery,
    version: "simfile.telemetry.v1"
  };
};

const MOLTNET_EVENT_KINDS = new Set(["world.dm", "world.message"]);

const markerIdsByEvent = (simfile: Simfile, trace: RuntimeTrace): Map<string, string[]> => {
  const hits = scanMarkers(trace.events, simfile.markers);
  const markersByEvent = new Map<string, string[]>();

  for (const [markerId, markerHits] of Object.entries(hits)) {
    for (const hit of markerHits) {
      const existing = markersByEvent.get(hit.eventId) ?? [];
      existing.push(markerId);
      markersByEvent.set(hit.eventId, existing);
    }
  }

  for (const markerIds of markersByEvent.values()) {
    markerIds.sort();
  }

  return markersByEvent;
};

const toMoltnetEntry = (
  event: RuntimeTrace["events"][number],
  markersByEvent: ReadonlyMap<string, string[]>
): MoltnetArtifactEntry => {
  const payload = event.payload && typeof event.payload === "object"
    ? event.payload as Record<string, unknown>
    : undefined;

  return {
    event_id: event.event_id,
    kind: event.kind as MoltnetArtifactEntry["kind"],
    marker_ids: markersByEvent.get(event.event_id) ?? [],
    rule_id: typeof payload?.rule === "string" ? payload.rule : undefined,
    scope: event.scope,
    sim_time: event.sim_time,
    target: event.target,
    text: typeof payload?.content === "string"
      ? payload.content
      : typeof payload?.reason === "string"
        ? payload.reason
        : undefined
  };
};

const buildMoltnetArtifact = (
  kind: MoltnetArtifactKind,
  simfile: Simfile,
  trace: RuntimeTrace
): MoltnetDeliveryArtifact | MoltnetTranscriptArtifact => {
  const markersByEvent = markerIdsByEvent(simfile, trace);
  const entries = trace.events
    .filter((event) => MOLTNET_EVENT_KINDS.has(event.kind))
    .map((event) => toMoltnetEntry(event, markersByEvent));

  return kind === "delivery"
    ? {
      source: "harness-derived",
      deliveries: entries,
      run_id: trace.runId,
      version: "simfile.moltnet.delivery.v1"
    }
    : {
      source: "harness-derived",
      entries,
      run_id: trace.runId,
      version: "simfile.moltnet.transcript.v1"
    };
};

const reportMoltnetSection = (options: RunRecordOptions): RunReport["moltnet"] | undefined => {
  if (options.moltnetArtifact !== "transcript") {
    return undefined;
  }
  return {
    transcript: evaluateTranscriptAcceptance({ source: "harness-derived" })
  };
};

export const writeRunRecord = async (options: RunRecordOptions): Promise<RunRecordResult> => {
  const trace = runSimfileTrace(options.simfile, {
    precision: options.precision,
    runId: options.runId,
    seed: options.seed,
    ticks: options.ticks,
    worldActs: options.worldActs
  });
  const markers = evaluateMarkers(options.simfile, trace);
  const probes = evaluateProbes(options.simfile, trace);
  const moltnet = reportMoltnetSection(options);
  const report: RunReport = {
    markers,
    ...(moltnet ? { moltnet } : {}),
    probes,
    run_id: options.runId,
    seed: options.seed,
    ticks: options.ticks,
    world_acts: trace.actResults
  };
  const telemetry = telemetryFor(options.simfile, trace);
  const viewerTrace = buildViewerTrace(options.simfile, trace, markers, probes);

  await mkdir(options.outDir, { recursive: true });
  const manifestPath = join(options.outDir, "manifest.yaml");
  const ledgerPath = join(options.outDir, "ledger.jsonl");
  const reportPath = join(options.outDir, "report.json");
  const telemetryPath = join(options.outDir, "telemetry.json");
  const viewerTracePath = join(options.outDir, "viewer-trace.json");
  const viewerExtensionsPath = join(options.outDir, "viewer-extensions.json");
  const moltnetArtifactPath = options.moltnetArtifact
    ? join(options.outDir, `moltnet-${options.moltnetArtifact}.json`)
    : undefined;
  const ledgerJsonl = `${serializeCanonicalEvents(trace.events).join("\n")}\n`;
  parseCanonicalLedgerJsonl(ledgerJsonl, { runId: options.runId });

  await writeFile(manifestPath, YAML.stringify(manifestFor(options)), "utf8");
  await writeFile(ledgerPath, ledgerJsonl, "utf8");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(telemetryPath, `${JSON.stringify(telemetry, null, 2)}\n`, "utf8");
  await writeFile(viewerTracePath, `${JSON.stringify(viewerTrace, null, 2)}\n`, "utf8");
  await writeFile(
    viewerExtensionsPath,
    options.viewerExtensionsBytes ?? emptyProjectViewerExtensionsBytes()
  );
  if (options.moltnetArtifact && moltnetArtifactPath) {
    const moltnetArtifact = buildMoltnetArtifact(options.moltnetArtifact, options.simfile, trace);
    await writeFile(moltnetArtifactPath, `${JSON.stringify(moltnetArtifact, null, 2)}\n`, "utf8");
  }

  return {
    ledgerPath,
    manifestPath,
    moltnetArtifactPath,
    outDir: options.outDir,
    report,
    reportPath,
    telemetryPath,
    trace,
    viewerTrace,
    viewerTracePath
  };
};
