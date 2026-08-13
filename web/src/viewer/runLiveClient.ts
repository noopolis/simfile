import type { RunTimeline } from "../store/timeline.js";
import type { ViewerContractTrace } from "./types.js";

export const livePendingProvenance = {
  mode: "live-pending" as const,
  engines: [],
  label: "engine provenance: not yet computed — the run must seal before engine provenance is recorded",
};

export const liveTimeline = (
  samples: ViewerContractTrace["spatial_samples"],
): RunTimeline => ({
  version: "simfile.run-timeline.v1",
  runId: "",
  elements: [...new Set((samples ?? []).flatMap((sample) =>
    (sample.objects ?? []).map((object) => object.id)))].map((id) => ({
    ref: id, kind: "agent" as const, label: id,
  })),
  events: (samples ?? []).map((sample, index) => ({
    t: index,
    eventId: `live-frame:${sample.tick}`,
    authority: "dynamics",
    streamId: "raw/frames.jsonl",
    seq: index,
    type: "clock.sync",
    viewClass: "clock" as const,
    recordedAt: new Date().toISOString(),
    subjects: [],
    causes: [],
    payload: { tick: sample.tick },
  })),
});

export const readRunFrameSse = async (
  response: Response,
  onEvent: (body: Record<string, unknown>) => void,
): Promise<void> => {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("GET /api/run-frames returned no body");
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const next = await reader.read();
    buffer += decoder.decode(next.value, { stream: !next.done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        onEvent(JSON.parse(line.slice(6)) as Record<string, unknown>);
      } catch {
        // A disconnected tail may be incomplete.
      }
    }
    if (next.done) return;
  }
};
