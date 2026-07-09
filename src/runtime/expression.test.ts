import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compileExpression } from "./expression.js";

describe("compileExpression", () => {
  it("evaluates function calls with comma-separated arguments", () => {
    const expression = compileExpression("clamp(0.4 * moon_fullness + 0.6 * evening_pull, 0, 1)");
    const value = expression.evaluate({
      t: 0,
      tick: 0,
      variables: {
        evening_pull: 0.5,
        moon_fullness: 0.5
      }
    });

    assert.equal(value, 0.5);
  });

  it("rewrites duration literals inside arithmetic expressions", () => {
    const expression = compileExpression("sin(2 * pi * t / 29d)");
    const value = expression.evaluate({
      t: 29 * 24 * 60 * 60,
      tick: 0,
      variables: {}
    });

    assert.ok(Math.abs(value) < 0.000001);
  });
});
