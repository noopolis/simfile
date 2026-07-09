import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseDuration, parseDurationMs, parseDurationSeconds } from "./duration.js";

describe("parseDurationMs", () => {
  it("parses milliseconds and higher units", () => {
    assert.equal(parseDurationMs("20ms"), 20);
    assert.equal(parseDurationMs("30s"), 30_000);
    assert.equal(parseDurationMs("2m"), 120_000);
    assert.equal(parseDurationMs("1.5h"), 5_400_000);
    assert.equal(parseDurationMs("1d"), 86_400_000);
    assert.equal(parseDurationMs("1w"), 604_800_000);
  });

  it("normalizes through parseDuration helpers", () => {
    assert.deepEqual(parseDuration("3s"), { value: 3, unit: "s", milliseconds: 3000 });
    assert.equal(parseDurationSeconds("1500ms"), 1.5);
  });

  it("rejects invalid duration forms", () => {
    assert.throws(() => parseDurationMs("20"), /invalid duration literal/);
    assert.throws(() => parseDurationMs("20minutes"), /invalid duration literal/);
    assert.throws(() => parseDurationMs("-1s"), /non-negative/);
    assert.throws(() => parseDurationMs("1e3s"), /invalid duration literal/);
  });
});
