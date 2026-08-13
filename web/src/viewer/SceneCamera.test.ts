import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GlyphCamera } from "glyphcss";

import { copyGlyphCameraState } from "./SceneCamera.js";

const project = (() => [0, 0, 0]) as GlyphCamera["project"];
const eyeDepth = (() => Number.POSITIVE_INFINITY) as GlyphCamera["eyeDepth"];

const camera = (offset: number): GlyphCamera => ({
  center: [0.5 + offset, 0.5],
  distance: 980 + offset,
  eyeDepth,
  eyeMode: false,
  fovScale: 1 + offset,
  kind: "perspective",
  mat: null,
  perspective: 32_000,
  project,
  rotX: 58 + offset,
  rotY: 42 + offset,
  stretch: 1,
  target: [offset, 0, 0],
  useMat: false,
  zoom: 58 + offset,
});

describe("dynamic GlyphCSS camera synchronization", () => {
  it("copies every mutable projection field exactly and then stabilizes", () => {
    const source = camera(3);
    const target = camera(0);
    assert.equal(copyGlyphCameraState(source, target), true);
    assert.deepEqual(target, source);
    assert.equal(copyGlyphCameraState(source, target), false);
  });
});
