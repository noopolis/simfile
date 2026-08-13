import type { DynamicsSession } from "../dynamics/session.js";
import type { DynamicsRunArtifactWriter } from "./dynamics-run-artifacts.js";

export const DYNAMICS_RUN_FRAMES_HEADER_VERSION =
  "simfile.dynamics-run-frames-header.v1" as const;
export const DYNAMICS_RUN_FRAME_VERSION =
  "simfile.dynamics-run-frame.v1" as const;

/**
 * Records the run's motion track: `raw/frames.jsonl`, one line per tick,
 * projected from the provider's optional `spatial()` seam.
 *
 * Why this file exists at all: a dynamics run record captures the match's
 * causality (steps, actions, events) but not its motion — body state appears
 * only in `replay/initial-session.json` and `replay/final-session.json`, so
 * every tick between the first and last was unrecoverable and `simfile view`
 * had nothing to animate. This is the only per-tick spatial carrier; it
 * duplicates no existing artifact.
 *
 * Why not record whole snapshots: on the repo's largest sim fixture full
 * `provider_state` measures ~44KB/tick (perception alone ~40KB) and would
 * roughly triple the record. The spatial projection is ~600B/tick, under 3%.
 *
 * SHAPE AND TAIL-SAFETY. Line 1 is a self-describing header (scene bounds and
 * the tick duration) so a reader needs no other file; every later line is one
 * tick. There is no footer and no rewrite, and the writer flushes at
 * acknowledgement barriers and syncs again when handles close, so
 * a partially-written staging run is a valid prefix. **Before seal**, readers
 * treat a truncated final line as not-yet-written and stop there. A sealed
 * run instead requires the manifest-bound exact bytes to parse completely.
 */
export interface DynamicsRunFrameRecorder {
  /**
   * Captures the frame for the tick the session is currently at. A provider
   * without `spatial()` still gets a timing-only tick record.
   */
  capture: (wallElapsedSeconds?: number) => Promise<void>;
}

export const createDynamicsRunFrameRecorder = async (params: {
  dt: number;
  session: DynamicsSession;
  writer: DynamicsRunArtifactWriter;
}): Promise<DynamicsRunFrameRecorder> => {
  const { dt, session, writer } = params;
  // The first projection is read before the header so the header can carry the
  // run's constant scene bounds; a provider reports them once and the record
  // keeps the first it sees.
  const first = session.spatial();
  await writer.appendJsonl("raw/frames.jsonl", {
    version: DYNAMICS_RUN_FRAMES_HEADER_VERSION,
    sim_seconds_per_tick: dt,
    ...(first?.bounds === undefined ? {} : { bounds: first.bounds })
  });

  const write = async (
    tick: number,
    objects: unknown,
    wallElapsedSeconds: number
  ): Promise<void> => {
    await writer.appendJsonl("raw/frames.jsonl", {
      version: DYNAMICS_RUN_FRAME_VERSION,
      tick,
      sim_seconds_advanced: tick === 0 ? 0 : dt,
      wall_elapsed_seconds: wallElapsedSeconds,
      ...(objects === undefined ? {} : { objects })
    });
  };

  if (first !== undefined) await write(session.nextTick, first.objects, 0);

  return {
    capture: async (wallElapsedSeconds = 0): Promise<void> => {
      const frame = session.spatial();
      await write(session.nextTick, frame?.objects, wallElapsedSeconds);
    }
  };
};
