import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { membraneColor } from "./membraneColor.js";

describe("membraneColor", () => {
  it("is deterministic for the same ref (replay determinism)", () => {
    assert.equal(membraneColor("team:luna"), membraneColor("team:luna"));
  });

  it("gives different membranes visually distinct colors", () => {
    assert.notEqual(membraneColor("team:luna"), membraneColor("team:selene"));
  });

  it("always returns a well-formed hsl() string", () => {
    assert.match(membraneColor("team:anything"), /^hsl\(\d+, 62%, 58%\)$/u);
  });
});
