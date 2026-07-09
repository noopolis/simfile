import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseRange } from "./range.js";

describe("parseRange", () => {
  it("parses inclusive numeric bounds", () => {
    assert.deepEqual(parseRange("0..1"), { min: 0, max: 1 });
    assert.deepEqual(parseRange("-0.5..0.5"), { min: -0.5, max: 0.5 });
    assert.deepEqual(parseRange("2..10"), { min: 2, max: 10 });
  });

  it("supports light whitespace around the delimiter", () => {
    assert.deepEqual(parseRange(" 1.0 .. 2.5 "), { min: 1, max: 2.5 });
  });

  it("rejects malformed ranges", () => {
    assert.throws(() => parseRange("0..0"), /lower bound must be smaller/);
    assert.throws(() => parseRange("2..1"), /smaller/);
    assert.throws(() => parseRange("one..two"), /invalid range literal/);
    assert.throws(() => parseRange("1...2"), /invalid range literal/);
  });
});
