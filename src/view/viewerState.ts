export interface ViewerStateConfig {
  readonly mode: "live" | "replay";
  readonly recordedViewerExtensions?: "ignored";
  readonly sourcePath: string;
  readonly statePath?: string;
}

export const buildViewerState = (
  config: ViewerStateConfig,
  effectiveMode: ViewerStateConfig["mode"] | "run-replay" | "run-live",
  now = new Date(),
): Record<string, unknown> => ({
  mode: effectiveMode,
  sourcePath: config.sourcePath,
  statePath: config.statePath,
  now: now.toISOString(),
  ...(config.recordedViewerExtensions === undefined
    ? {}
    : { recordedViewerExtensions: config.recordedViewerExtensions }),
});
