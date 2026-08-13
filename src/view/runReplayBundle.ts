import { resolve } from "node:path";

import { isObserveRunDir } from "./runDetect.js";
import { applyRunFrameTrack, readRunFrames } from "./runFrames.js";
import { buildRunTimeline, readWorldRooms } from "./runTimeline.js";
import type { RunTimeline } from "./runTimelineTypes.js";
import { readRunViewerExtensionData } from "./runViewerExtensionData.js";
import { readRunViewerProjection } from "./runViewerProjection.js";
import { buildRunViewModel } from "./runViewModel.js";
import type { RunViewModel } from "./runViewModelTypes.js";
import { buildMembraneInteriorWorlds, buildRunWorldTrace } from "./runWorldTrace.js";
import type { RunWorldTrace } from "./runWorldTrace.js";
import { readRunSpatialWorld } from "./runWorldTraceSpatial.js";
import type { ViewerServerConfig } from "./server.js";

export interface RunReplayBundle {
  model: RunViewModel;
  timeline: RunTimeline;
  world: RunWorldTrace;
  frames: Awaited<ReturnType<typeof readRunFrames>>;
}

export const runReplayMetaResponse = (
  bundle: RunReplayBundle,
): Record<string, unknown> => ({
  runId: bundle.model.runId,
  verdict: bundle.model.verdict,
  provenance: bundle.model.provenance,
  engineProvenance: bundle.model.engineProvenance,
  participants: bundle.model.participants,
  seedSpread: bundle.model.seedSpread,
  spreadSummary: bundle.model.spreadSummary,
  variableSamples: bundle.model.variableSamples,
  pace: bundle.model.pace,
  timing: bundle.frames?.timing,
  simSecondsPerTick: bundle.frames?.simSecondsPerTick,
});

/** Builds one sealed run-replay bundle after the manifest-shape gate. */
export const loadRunReplayBundle = async (
  config: ViewerServerConfig,
): Promise<RunReplayBundle | null> => {
  if (config.mode !== "replay" || config.statePath) return null;
  const runDir = resolve(config.sourcePath);
  if (!(await isObserveRunDir(runDir))) return null;
  const [
    model,
    timeline,
    worldRooms,
    spatialWorld,
    frames,
    extensionData,
    viewerProjection,
  ] =
    await Promise.all([
      buildRunViewModel(runDir),
      buildRunTimeline(runDir),
      readWorldRooms(runDir),
      readRunSpatialWorld(runDir),
      readRunFrames(runDir),
      readRunViewerExtensionData(runDir),
      readRunViewerProjection(runDir),
    ]);
  const interiorRoomRefs = new Set(
    timeline.membranes?.flatMap((membrane) => membrane.interiorRooms) ?? [],
  );
  const outerRooms = worldRooms.filter((room) =>
    !interiorRoomRefs.has(room.ref));
  const baseWorld = viewerProjection ?? buildRunWorldTrace({
    runId: model.runId,
    runName: model.runId,
    world: model.world,
    rooms: outerRooms.map((room) => ({
      networkId: room.networkId,
      roomId: room.roomId,
      members: room.members,
    })),
    spatialWorld,
    timeline,
  });
  const world = {
    ...applyRunFrameTrack(baseWorld, frames),
    ...(extensionData === undefined
      ? {}
      : { viewer_extension_data: extensionData }),
    ...(config.extensionIdentities === undefined
      ? {}
      : { viewer_extensions: config.extensionIdentities }),
  };
  return {
    model,
    world,
    frames,
    timeline: {
      ...timeline,
      membranes: buildMembraneInteriorWorlds(
        timeline.membranes ?? [],
        timeline,
      ),
    },
  };
};
