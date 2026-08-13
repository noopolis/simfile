interface GlyphPerfGlobal {
  __SIMFILE_DYNAMIC_GLYPH_PERF__?: DynamicGlyphPerf;
  __glyphPerf?: {
    dom?: number[];
    raster?: number[];
  };
}

export interface DynamicGlyphPerf {
  commit: number[];
  dom: number[];
  raster: number[];
  renders: number;
  scale: number;
}

const sampleLimit = 6_000;

export function dynamicGlyphPerf(): DynamicGlyphPerf {
  const target = globalThis as typeof globalThis & GlyphPerfGlobal;
  return target.__SIMFILE_DYNAMIC_GLYPH_PERF__ ??= {
    commit: [],
    dom: [],
    raster: [],
    renders: 0,
    scale: 1,
  };
}

export function measureDynamicGlyphRerender(
  render: () => void,
  scale: number,
): void {
  const target = globalThis as typeof globalThis & GlyphPerfGlobal;
  const before = target.__glyphPerf?.raster?.length ?? 0;
  const startedAt = performance.now();
  render();
  recordDynamicGlyphMeasurement(before, startedAt, scale);
}

export function recordDynamicGlyphAfterMicrotask(
  before: number,
  startedAt: number,
  scale: number,
): void {
  queueMicrotask(() => recordDynamicGlyphMeasurement(before, startedAt, scale));
}

function recordDynamicGlyphMeasurement(
  before: number,
  startedAt: number,
  scale: number,
): void {
  const target = globalThis as typeof globalThis & GlyphPerfGlobal;
  const glyph = target.__glyphPerf;
  const raster = glyph?.raster?.slice(before) ?? [];
  const dom = glyph?.dom?.slice(before) ?? [];
  if (raster.length === 0 && dom.length === 0) return;
  const store = dynamicGlyphPerf();
  store.scale = scale;
  store.renders += Math.max(raster.length, dom.length, 1);
  store.raster.push(...raster);
  store.dom.push(...dom);
  store.commit.push(performance.now() - startedAt);
  trim(store.raster);
  trim(store.dom);
  trim(store.commit);
}

function trim(samples: number[]): void {
  if (samples.length > sampleLimit) {
    samples.splice(0, samples.length - sampleLimit);
  }
}
