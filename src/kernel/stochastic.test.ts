import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { drawUniform } from "./stochastic.js";

describe("drawUniform", () => {
  it("is deterministic for the same input tuple", () => {
    const value1 = drawUniform({
      runSeed: "seed-a",
      generatorId: "g-01",
      tick: 12,
      drawIndex: 0,
      min: -1,
      max: 1
    });
    const value2 = drawUniform({
      runSeed: "seed-a",
      generatorId: "g-01",
      tick: 12,
      drawIndex: 0,
      min: -1,
      max: 1
    });
    assert.equal(value1, value2);
  });

  it("produces different values when drawIndex changes", () => {
    const value1 = drawUniform({
      runSeed: "seed-a",
      generatorId: "g-01",
      tick: 12,
      drawIndex: 0,
      min: 0,
      max: 10
    });
    const value2 = drawUniform({
      runSeed: "seed-a",
      generatorId: "g-01",
      tick: 12,
      drawIndex: 1,
      min: 0,
      max: 10
    });
    assert.ok(value1 !== value2);
  });

  it("validates distribution bounds", () => {
    assert.throws(() => drawUniform({
      runSeed: "seed-a",
      generatorId: "g-01",
      tick: 1,
      drawIndex: 0,
      min: 5,
      max: 2
    }), /max must be >= min/);
  });
});
