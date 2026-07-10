import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { clampAndRound, finite } from "./numeric.js";

describe("finite", () => {
  it("substitutes 0 for non-finite values", () => {
    assert.equal(finite(Number.NaN), 0);
    assert.equal(finite(Number.POSITIVE_INFINITY), 0);
    assert.equal(finite(3.5), 3.5);
  });
});

describe("clampAndRound", () => {
  const range = { min: 0, max: 10 };

  it("clamps values outside the range", () => {
    assert.equal(clampAndRound(-5, range, 2), 0);
    assert.equal(clampAndRound(15, range, 2), 10);
  });

  it("rounds to the requested precision", () => {
    assert.equal(clampAndRound(1.23456, range, 2), 1.23);
  });

  it("normalizes negative zero to zero", () => {
    assert.equal(Object.is(clampAndRound(-0.0001, range, 0), 0), true);
  });
});
