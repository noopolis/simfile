export type ReportTranscriptSource = "harness-derived" | "moltnet-exported";

export interface ReportTranscriptSourceArtifact {
  source?: string;
}

export interface TranscriptAcceptanceResult {
  accepted: boolean;
  reason?: string;
  required_source: "moltnet-exported";
  source?: ReportTranscriptSource | "unknown";
}

const acceptedSource = "moltnet-exported" satisfies ReportTranscriptSource;

export const evaluateTranscriptAcceptance = (
  artifact?: ReportTranscriptSourceArtifact
): TranscriptAcceptanceResult => {
  if (artifact?.source === acceptedSource) {
    return {
      accepted: true,
      required_source: acceptedSource,
      source: acceptedSource
    };
  }

  const source = artifact?.source === "harness-derived" ? artifact.source : "unknown";
  return {
    accepted: false,
    reason: "live simulation acceptance requires a moltnet-exported transcript",
    required_source: acceptedSource,
    source
  };
};
