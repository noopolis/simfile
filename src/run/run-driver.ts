import { readFile } from "node:fs/promises";

import { type MoltnetArtifactKind, writeRunRecord } from "../runtime/trace.js";
import type { QueuedWorldAct } from "../runtime/types.js";
import type { Simfile } from "../schema/model.js";
import {
  bindProjectViewerExtensions,
  loadProjectViewerExtensions,
} from "../viewer-extension/projectDeclaration.js";
import { writeDynamicsRunRecord } from "./dynamics-run-record.js";

export interface SimfileRunDriverOptions {
  actsPath?: string;
  clock: () => Date;
  moltnetArtifact?: MoltnetArtifactKind;
  outDir: string;
  runId: string;
  seed: string;
  simfile: Simfile;
  simfilePath: string;
  sourceText: string;
  ticks: number;
}

export interface SimfileRunDriverResult {
  driver: "trace" | "dynamics";
  outDir: string;
  runId: string;
}

const loadQueuedWorldActs = async (
  actsPath?: string
): Promise<QueuedWorldAct[] | undefined> => {
  if (!actsPath) {
    return undefined;
  }
  const raw = JSON.parse(await readFile(actsPath, "utf8")) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error(`--acts file must contain a JSON array: ${actsPath}`);
  }
  return raw as QueuedWorldAct[];
};

export const assertDynamicsSimfileHasNoTraceDeclarations = (
  simfile: Simfile
): void => {
  const offenders: string[] = [];
  for (const [name, declarations] of [
    ["places", simfile.places],
    ["routes", simfile.routes],
    ["presence", simfile.presence],
    ["variables", simfile.variables],
    ["generators", simfile.generators],
    ["rules", simfile.rules],
    ["markers", simfile.markers],
    ["probes", simfile.probes]
  ] as const) {
    if (Object.keys(declarations).length > 0) offenders.push(name);
  }
  if (simfile.ledger !== undefined) offenders.push("ledger");
  if (simfile.telemetry !== undefined) offenders.push("telemetry");
  if (Object.keys(simfile.clock.phases).length > 0) {
    offenders.push("clock.phases");
  }
  offenders.sort();
  if (offenders.length > 0) {
    throw new Error(
      "simfile run cannot execute a dynamics Simfile that also declares "
      + `trace mechanics (${offenders.join(", ")}); engine composition is a `
      + "separate item (B158) — split the Simfile"
    );
  }
};

export const executeSimfileRun = async (
  options: SimfileRunDriverOptions
): Promise<SimfileRunDriverResult> => {
  const viewerExtensions = await loadProjectViewerExtensions(options.simfilePath);
  const recordedViewerExtensions = await bindProjectViewerExtensions(viewerExtensions);
  if (options.simfile.dynamics === undefined) {
    const worldActs = await loadQueuedWorldActs(options.actsPath);
    const record = await writeRunRecord({
      moltnetArtifact: options.moltnetArtifact,
      outDir: options.outDir,
      runId: options.runId,
      seed: options.seed,
      simfile: options.simfile,
      sourcePath: options.simfilePath,
      sourceText: options.sourceText,
      ticks: options.ticks,
      viewerExtensionsBytes: recordedViewerExtensions,
      worldActs
    });
    return { driver: "trace", outDir: record.outDir, runId: options.runId };
  }

  assertDynamicsSimfileHasNoTraceDeclarations(options.simfile);
  if (options.actsPath !== undefined) {
    throw new Error(
      "--acts supplies trace-protocol variable acts; a dynamics run accepts "
      + "no queued acts on the local path"
    );
  }
  if (options.moltnetArtifact !== undefined) {
    throw new Error(
      "--moltnet-artifact derives from trace events; a dynamics run has none "
      + "on the local path"
    );
  }

  const record = await writeDynamicsRunRecord({
    outDir: options.outDir,
    runId: options.runId,
    seed: options.seed,
    simfile: options.simfile,
    simfilePath: options.simfilePath,
    sourceText: options.sourceText,
    ticks: options.ticks,
    seams: { clock: options.clock },
    viewerExtensionsBytes: recordedViewerExtensions
  });
  return { driver: "dynamics", outDir: record.outDir, runId: record.runId };
};
