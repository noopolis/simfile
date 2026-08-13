import { watch, type FSWatcher } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { ServerResponse } from "node:http";

import { applyRunFrameTrack, readRunFrames, readRunFramesFrom, type RunFramesFrom } from "./runFrames.js";
import type { RunWorldTrace } from "./runWorldTrace.js";
import type { RunViewerExtensionIdentity } from "./runViewerExtensions.js";
import type { RunSealFollower } from "./runSealFollower.js";
import {
  readRunViewerExtensionData,
  readStagingViewerExtensionData,
} from "./runViewerExtensionData.js";

const fallbackPollMs = 200;

const openStream = (res: ServerResponse): void => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": viewer run-follow stream\n\n");
};

const event = (res: ServerResponse, payload: Record<string, unknown>): boolean =>
  res.write(`data: ${JSON.stringify(payload)}\n\n`);

const isPresent = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const headerEvent = (parsed: RunFramesFrom): Record<string, unknown> | undefined => {
  if (parsed.header === undefined) return undefined;
  const header = parsed.header;
  return {
    type: "header",
    simSecondsPerTick: header.sim_seconds_per_tick,
    bounds: header.bounds,
  };
};

const monotonicOffset = (offsetBytes: number, nextOffsetBytes: number): number =>
  Math.max(offsetBytes, nextOffsetBytes);

const timingByTick = (parsed: RunFramesFrom): Map<number, RunFramesFrom["timing"][number]> =>
  new Map(parsed.timing.map((timing) => [timing.tick, timing]));

export const readLiveWorld = async (
  stagingDir: string,
  extensionIdentities: readonly RunViewerExtensionIdentity[] = [],
  sealed = false,
): Promise<RunWorldTrace> => {
  const frames = await readRunFrames(stagingDir);
  const base: RunWorldTrace = {
    version: "viewer.trace.v1", run_id: "", run_name: "", rooms: [], corridors: [],
    agents: [], presence: [], ledger_facts: [], signals: [], spatial_samples: [],
    viewer_extensions: extensionIdentities,
  };
  const extensionData = sealed
    ? await readRunViewerExtensionData(stagingDir)
    : await readStagingViewerExtensionData(stagingDir);
  return {
    ...applyRunFrameTrack(base, frames),
    ...(extensionData === undefined ? {} : {
      viewer_extension_data: extensionData,
    }),
  };
};

export const sendRunFrames = async (
  res: ServerResponse,
  runDir: string,
  stagingDir: string,
  sealFollower?: RunSealFollower,
): Promise<void> => {
  openStream(res);
  const requestedFramesPath = join(stagingDir, "raw", "frames.jsonl");
  const sealedFramesPath = join(runDir, "raw", "frames.jsonl");
  let framesPath = requestedFramesPath;
  let offsetBytes = 0;
  let headerSent = false;
  let lastExtensionData: string | undefined;
  let skippedFrames = 0;
  let polling = false;
  let ended = false;
  let watcher: FSWatcher | undefined;

  const cleanup = (): void => {
    ended = true;
    clearInterval(pollTimer);
    watcher?.close();
  };

  const finishSealed = (identities: readonly RunViewerExtensionIdentity[]): void => {
    if (ended) return;
    ended = true;
    watcher?.close();
    clearInterval(pollTimer);
    try {
      event(res, { type: "sealed", viewerExtensions: identities,
        ...(skippedFrames === 0 ? {} : { skippedFrames }) });
    } finally {
      res.end();
    }
  };

  const finishFailed = (error: string): void => {
    if (ended) return;
    ended = true;
    watcher?.close();
    clearInterval(pollTimer);
    try { event(res, { type: "viewer-extension-mismatch", error }); }
    finally { res.end(); }
  };

  const writeFrame = (sample: RunFramesFrom["samples"][number], timing: RunFramesFrom["timing"][number] | undefined): void => {
    if (res.writableNeedDrain || res.destroyed) {
      skippedFrames += 1;
      return;
    }
    const payload: Record<string, unknown> = {
      type: "frame",
      tick: sample.tick,
      sample,
      ...(timing === undefined ? {} : { timing }),
      ...(skippedFrames === 0 ? {} : { skippedFrames }),
    };
    const written = event(res, payload);
    skippedFrames = written ? 0 : skippedFrames;
  };

  const poll = async (): Promise<void> => {
    if (polling || ended || res.destroyed) return;
    polling = true;
    try {
      const parsed = await readRunFramesFrom(framesPath, offsetBytes);
      offsetBytes = monotonicOffset(offsetBytes, parsed.nextOffsetBytes);
      if (!headerSent) {
        const header = headerEvent(parsed);
        if (header !== undefined) {
          headerSent = true;
          event(res, header);
        }
      }
      const timing = timingByTick(parsed);
      parsed.samples.forEach((sample) => writeFrame(sample, timing.get(sample.tick)));
      if (framesPath === requestedFramesPath) {
        const extensionData = await readStagingViewerExtensionData(stagingDir);
        if (extensionData !== undefined) {
          const serialized = JSON.stringify(extensionData);
          if (serialized !== lastExtensionData) {
            event(res, { type: "viewer-extension-data", extensionData });
            lastExtensionData = serialized;
          }
        }
      }
      if (framesPath === requestedFramesPath && await isPresent(join(runDir, "manifest.json"))) {
        framesPath = sealedFramesPath;
        const final = await readRunFramesFrom(framesPath, offsetBytes);
        offsetBytes = monotonicOffset(offsetBytes, final.nextOffsetBytes);
        const finalTiming = timingByTick(final);
        final.samples.forEach((sample) => writeFrame(sample, finalTiming.get(sample.tick)));
      }
      if (framesPath === sealedFramesPath) {
        const seal = sealFollower?.getState();
        if (seal?.status === "live") return;
        if (seal?.status === "failed") {
          finishFailed(seal.error ?? "viewer extension identity reconciliation failed");
          return;
        }
        try {
          const extensionData = await readRunViewerExtensionData(runDir);
          if (extensionData !== undefined) {
            event(res, { type: "viewer-extension-data", extensionData });
          }
        } catch (error) {
          finishFailed(error instanceof Error ? error.message : String(error));
          return;
        }
        finishSealed(seal?.identities ?? []);
      }
    } catch (error) {
      finishFailed(error instanceof Error ? error.message : String(error));
    } finally {
      polling = false;
    }
  };

  try {
    watcher = watch(requestedFramesPath, () => void poll());
  } catch {
    // The first flush may not have created the file. The bounded fallback
    // discovers it without touching the producer's file handle.
  }
  const pollTimer = setInterval(() => void poll(), fallbackPollMs);
  res.on("close", cleanup);
  await poll();
};
