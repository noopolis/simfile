import type { RunTimeline } from "../store/timeline.js";
import type { ViewerContractTrace } from "./types.js";

const spatialSampleEvents = (
  samples: NonNullable<ViewerContractTrace["spatial_samples"]>,
): RunTimeline["events"] => samples.map((sample, index) => ({
    t: index,
    eventId: `spatial-sample:${sample.tick}:${index}`,
    authority: "viewer",
    streamId: "viewer.trace.v1#spatial_samples",
    seq: index,
    type: "spatial.sample",
    viewClass: "other" as const,
    // Sample rows carry a simulated tick, not a wall timestamp. This explicit
    // coordinate avoids inventing recorded-at evidence for the UI readout.
    recordedAt: `tick ${sample.tick}`,
    subjects: [],
    causes: [],
    payload: { tick: sample.tick },
  }));

/**
 * A sealed causal timeline remains authoritative whenever it has events. A
 * genuinely spatial-only record still needs one global cursor, so its actual
 * spatial-sample rows become a deterministic temporary axis instead of
 * leaving every pane and extension pinned to `0/0`.
 */
export const sealedReplayTimeline = (
  timeline: RunTimeline,
  samples: ViewerContractTrace["spatial_samples"],
): RunTimeline => {
  if (timeline.events.length > 0 || !samples || samples.length === 0) return timeline;
  return {
    ...timeline,
    events: spatialSampleEvents(samples),
  };
};
