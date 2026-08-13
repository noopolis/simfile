import type { SpatialPlaybackState } from "./spatialPlayback.js";
import { dynamicGlyphPerf } from "./dynamicGlyphTelemetry.js";

const diagnosticsPublishMs = 500;

export interface PlaybackDiagnosticsSnapshot {
  callbackFps: number;
  dynamicCommitP95Ms: number;
  dynamicGlyphRenders: number;
  dynamicRasterP95Ms: number;
  gapsOver100Ms: number;
  glyphDomMeanMs: number;
  glyphRasterMeanMs: number;
  glyphRenders: number;
  longFrames: number;
  maxFrameGapMs: number;
  observedSpeed: number;
  positionFps: number;
  wallElapsedMs: number;
}

export interface PlaybackProbe {
  frameCount: number;
  glyphRenderStart: number;
  dynamicCommitStart: number;
  dynamicRasterStart: number;
  dynamicRenderStart: number;
  gapsOver100Ms: number;
  lastPublishedAtMs: number;
  longFrames: number;
  maxFrameGapMs: number;
  positionFrameStart: number;
  startTick: number;
  staticRenderStart: number;
  startedAtMs: number;
}

interface PlaybackInstrumentationGlobal {
  __SIMFILE_PLAYBACK_DIAGNOSTICS__?: Record<string, number | boolean>;
  __glyphPerf?: {
    dom?: number[];
    raster?: number[];
  };
}

export function recordPlaybackDiagnostics(
  probeRef: { current: PlaybackProbe | null },
  prior: SpatialPlaybackState,
  next: SpatialPlaybackState,
  now: number,
  elapsedMs: number,
  tickDurationMs: number,
  targetSpeed: number,
): PlaybackDiagnosticsSnapshot | null {
  const instrumentation = globalThis as typeof globalThis & PlaybackInstrumentationGlobal;
  const shared = instrumentation.__SIMFILE_PLAYBACK_DIAGNOSTICS__ ??= {};
  const glyph = instrumentation.__glyphPerf;
  const dynamic = dynamicGlyphPerf();
  let probe = probeRef.current;
  if (probe === null) {
    probe = {
      frameCount: 0,
      dynamicCommitStart: dynamic.commit.length,
      dynamicRasterStart: dynamic.raster.length,
      dynamicRenderStart: dynamic.renders,
      gapsOver100Ms: 0,
      glyphRenderStart: glyph?.raster?.length ?? 0,
      lastPublishedAtMs: now,
      longFrames: 0,
      maxFrameGapMs: 0,
      positionFrameStart: Number(shared.positionFrames ?? 0),
      startTick: prior.tick,
      startedAtMs: now,
      staticRenderStart: Number(shared.staticGlyphRenders ?? 0),
    };
    probeRef.current = probe;
  }
  if (elapsedMs > 0) {
    probe.frameCount += 1;
    probe.maxFrameGapMs = Math.max(probe.maxFrameGapMs, elapsedMs);
    if (elapsedMs > 34) probe.longFrames += 1;
    if (elapsedMs > 100) probe.gapsOver100Ms += 1;
  }
  const wallElapsedMs = Math.max(0, now - probe.startedAtMs);
  const simulatedElapsedMs = Math.max(0, next.tick - probe.startTick) * tickDurationMs;
  const glyphRenders = Math.max(0, (glyph?.raster?.length ?? 0) - probe.glyphRenderStart);
  const positionFrames = Math.max(
    0,
    Number(shared.positionFrames ?? 0) - probe.positionFrameStart,
  );
  const glyphRaster = glyph?.raster?.slice(probe.glyphRenderStart) ?? [];
  const glyphDom = glyph?.dom?.slice(probe.glyphRenderStart) ?? [];
  const dynamicCommit = dynamic.commit.slice(probe.dynamicCommitStart);
  const dynamicRaster = dynamic.raster.slice(probe.dynamicRasterStart);
  const snapshot: PlaybackDiagnosticsSnapshot = {
    callbackFps: wallElapsedMs > 0 ? probe.frameCount * 1_000 / wallElapsedMs : 0,
    dynamicCommitP95Ms: percentile(dynamicCommit, 0.95),
    dynamicGlyphRenders: Math.max(0, dynamic.renders - probe.dynamicRenderStart),
    dynamicRasterP95Ms: percentile(dynamicRaster, 0.95),
    gapsOver100Ms: probe.gapsOver100Ms,
    glyphDomMeanMs: mean(glyphDom),
    glyphRasterMeanMs: mean(glyphRaster),
    glyphRenders,
    longFrames: probe.longFrames,
    maxFrameGapMs: probe.maxFrameGapMs,
    observedSpeed: wallElapsedMs > 0 ? simulatedElapsedMs / wallElapsedMs : targetSpeed,
    positionFps: wallElapsedMs > 0 ? positionFrames * 1_000 / wallElapsedMs : 0,
    wallElapsedMs,
  };
  Object.assign(shared, {
    active: next.playing,
    callbackFps: snapshot.callbackFps,
    domNodes: domNodeCount(),
    dynamicCommitMaxMs: maximum(dynamicCommit),
    dynamicCommitP50Ms: percentile(dynamicCommit, 0.5),
    dynamicCommitP95Ms: snapshot.dynamicCommitP95Ms,
    dynamicGlyphCharacters: dynamicGlyphCharacters(),
    dynamicGlyphRenders: snapshot.dynamicGlyphRenders,
    dynamicRasterMaxMs: maximum(dynamicRaster),
    dynamicRasterP50Ms: percentile(dynamicRaster, 0.5),
    dynamicRasterP95Ms: snapshot.dynamicRasterP95Ms,
    dynamicScale: dynamic.scale,
    gapsOver100Ms: snapshot.gapsOver100Ms,
    glyphDomMeanMs: snapshot.glyphDomMeanMs,
    glyphRasterMeanMs: snapshot.glyphRasterMeanMs,
    glyphRenders: snapshot.glyphRenders,
    longFrames: snapshot.longFrames,
    maxFrameGapMs: snapshot.maxFrameGapMs,
    observedSpeed: snapshot.observedSpeed,
    positionFps: snapshot.positionFps,
    simulatedElapsedMs,
    staticGlyphRenders: Math.max(
      0,
      Number(shared.staticGlyphRenders ?? 0) - probe.staticRenderStart,
    ),
    targetSpeed,
    tick: next.tick,
    usedJsHeapBytes: usedJsHeapBytes(),
    wallElapsedMs,
  });
  if (now - probe.lastPublishedAtMs < diagnosticsPublishMs && next.playing) {
    return null;
  }
  probe.lastPublishedAtMs = now;
  return snapshot;
}

export function publishPlaybackDiagnostics(): void {
  const instrumentation = globalThis as typeof globalThis & PlaybackInstrumentationGlobal;
  const body = instrumentation.__SIMFILE_PLAYBACK_DIAGNOSTICS__;
  if (!body || typeof fetch !== "function") return;
  void fetch("/api/playback-diagnostics", {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    keepalive: true,
    method: "POST",
  }).catch(() => undefined);
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1),
  )]!;
}

function maximum(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

function domNodeCount(): number {
  return typeof document === "undefined"
    ? 0
    : document.getElementsByTagName("*").length;
}

function dynamicGlyphCharacters(): number {
  if (typeof document === "undefined") return 0;
  return [...document.querySelectorAll(".dynamic-glyph-host .glyph-output")]
    .reduce((total, element) => total + (element.textContent?.length ?? 0), 0);
}

function usedJsHeapBytes(): number {
  const memory = (performance as Performance & {
    memory?: { usedJSHeapSize?: number };
  }).memory;
  return Number(memory?.usedJSHeapSize ?? 0);
}
