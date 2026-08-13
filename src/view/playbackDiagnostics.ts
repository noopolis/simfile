import type { IncomingMessage } from "node:http";

const playbackDiagnosticKeys = new Set([
  "active",
  "callbackFps",
  "cameraAlignmentError",
  "domNodes",
  "dynamicCommitMaxMs",
  "dynamicCommitP50Ms",
  "dynamicCommitP95Ms",
  "dynamicGlyphCharacters",
  "dynamicGlyphRenders",
  "dynamicRasterMaxMs",
  "dynamicRasterP50Ms",
  "dynamicRasterP95Ms",
  "dynamicRendererGlyph",
  "dynamicScale",
  "gapsOver100Ms",
  "glyphDomMeanMs",
  "glyphRasterMeanMs",
  "glyphRenders",
  "longFrames",
  "maxFrameGapMs",
  "observedSpeed",
  "positionCommits",
  "positionFps",
  "positionFrames",
  "projectionAlignmentErrorPx",
  "projectionAlignmentMaxErrorPx",
  "simulatedElapsedMs",
  "staticGlyphRenders",
  "targetSpeed",
  "tick",
  "usedJsHeapBytes",
  "wallElapsedMs",
]);
const playbackDiagnosticsMaxBytes = 4_096;

export const readPlaybackDiagnostics = async (
  req: IncomingMessage,
): Promise<Record<string, number | boolean>> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > playbackDiagnosticsMaxBytes) {
      throw new TypeError("playback diagnostics body is too large");
    }
    chunks.push(buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("playback diagnostics must be an object");
  }
  const output: Record<string, number | boolean> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!playbackDiagnosticKeys.has(key)) continue;
    if (typeof value === "boolean") {
      output[key] = value;
      continue;
    }
    if (
      typeof value === "number"
      && Number.isFinite(value)
      && Math.abs(value) <= 1e9
    ) {
      output[key] = value;
    }
  }
  return output;
};
