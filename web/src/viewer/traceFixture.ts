import type { ViewerWorldErrorResponse } from "./types.js";

export const replayRequiredArtifacts = ["manifest.yaml", "viewer-trace.json"] as const;

export const replayMissingArtifactMessage = (
  sourcePath: string,
  missingArtifacts: readonly string[] = replayRequiredArtifacts,
): string => `Replay data must come from a sealed run directory. Missing artifacts in ${sourcePath}: ${missingArtifacts.join(", ")}`;

export const replayModeErrorHeadline = "Replay artifact check failed";

export const isReplayWorldError = (error: ViewerWorldErrorResponse | unknown): error is ViewerWorldErrorResponse => {
  return typeof error === "object"
    && error !== null
    && (error as ViewerWorldErrorResponse).mode === "replay";
};
