import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  readDynamicRendererConfig,
  scaledRenderGrid,
} from "./DynamicGlyphScene.js";

describe("dynamic GlyphCSS renderer config", () => {
  it("defaults to full-resolution GlyphCSS and keeps DOM explicit", () => {
    assert.deepEqual(readDynamicRendererConfig(""), {
      renderer: "glyph",
      scale: 1,
    });
    assert.deepEqual(readDynamicRendererConfig("?dynamic-renderer=dom"), {
      renderer: "dom",
      scale: 1,
    });
  });

  it("accepts only bounded measured downscales", () => {
    assert.deepEqual(readDynamicRendererConfig("?dynamic-scale=2"), {
      renderer: "glyph",
      scale: 2,
    });
    assert.deepEqual(readDynamicRendererConfig("?dynamic-scale=4"), {
      renderer: "glyph",
      scale: 4,
    });
    assert.equal(readDynamicRendererConfig("?dynamic-scale=8").scale, 1);
    assert.deepEqual(
      scaledRenderGrid({ cols: 291, rows: 83 }, 2),
      { cols: 146, rows: 42 },
    );
  });
});
