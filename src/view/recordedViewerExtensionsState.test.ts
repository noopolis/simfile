import assert from "node:assert/strict";
import test from "node:test";

import { buildViewerState } from "./viewerState.js";

test("viewer state marks an explicit recorded-extension bypass", () => {
  const state = buildViewerState({
    mode: "replay",
    recordedViewerExtensions: "ignored",
    sourcePath: ".",
  }, "run-replay", new Date("2000-01-01T00:00:00.000Z"));
  assert.equal(state.recordedViewerExtensions, "ignored");
  assert.equal(state.mode, "run-replay");
});
