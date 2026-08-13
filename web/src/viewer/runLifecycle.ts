import type { RunTimeline } from "../store/timeline.js";
import type { RunMeta } from "./RunMetaPanels.js";
import type { ViewerWorldResponse } from "./types.js";

export interface SealedRunLifecycle {
  readonly mode: "run-replay";
  readonly runMeta: RunMeta;
  readonly timeline: RunTimeline;
  readonly world: ViewerWorldResponse;
}

export const fetchSealedRunLifecycle = async (): Promise<SealedRunLifecycle> => {
  const response = await fetch("/api/run-lifecycle");
  if (!response.ok) {
    throw new Error(`GET /api/run-lifecycle failed with ${response.status}`);
  }
  return response.json() as Promise<SealedRunLifecycle>;
};
