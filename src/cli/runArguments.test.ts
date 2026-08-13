import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseRunArguments } from "./runArguments.js";

describe("run argument matrix", () => {
  const values = Object.freeze([
    ["--ticks", "3", "ticks", 3],
    ["--out", "runs/one", "outDir", "runs/one"],
    ["--seed", "seed-one", "seed", "seed-one"],
    ["--run-id", "run-one", "runId", "run-one"],
    ["--acts", "acts.json", "actsPath", "acts.json"],
    ["--clock", "2026-08-07T00:00:00Z", "clock", "2026-08-07T00:00:00Z"],
    ["--moltnet-artifact", "transcript", "moltnetArtifact", "transcript"],
    ["--spawnfile-report", "report.json", "spawnfileReport", "report.json"],
  ] as const);

  for (const [flag, value, key, expected] of values) {
    it(`accepts ${flag} in split and equals forms`, () => {
      assert.equal(parseRunArguments(["Simfile", flag, value])[key], expected);
      assert.equal(parseRunArguments(["Simfile", `${flag}=${value}`])[key], expected);
    });
    it(`rejects absent ${flag} values`, () => {
      assert.throws(() => parseRunArguments(["Simfile", flag]), /Missing value/u);
      assert.throws(() => parseRunArguments(["Simfile", `${flag}=`]), /Missing value/u);
      assert.throws(() => parseRunArguments(["Simfile", flag, "--view"]), /Missing value/u);
    });
  }

  it("accepts local/view switches and rejects duplicate or unknown flags", () => {
    assert.equal(parseRunArguments(["Simfile", "--local"]).local, true);
    assert.equal(parseRunArguments(["Simfile", "--view"]).view, true);
    assert.throws(() => parseRunArguments(["Simfile", "--view", "--view"]), /Duplicate/u);
    assert.throws(() => parseRunArguments(["Simfile", "--future"]), /Unknown flag/u);
    assert.throws(() => parseRunArguments([]), /Missing Simfile/u);
    assert.throws(() => parseRunArguments(["one", "two"]), /Unexpected positional/u);
  });

  it("rejects invalid, unsafe, and duplicate valued flags", () => {
    for (const value of ["-1", "1.5", "NaN", "Infinity"]) {
      assert.throws(() => parseRunArguments(["Simfile", `--ticks=${value}`]), /Invalid/u);
    }
    assert.throws(() => parseRunArguments(["Simfile", "--out=a", "--out=b"]), /Duplicate/u);
    assert.throws(() => parseRunArguments([
      "Simfile", "--moltnet-artifact=messages",
    ]), /Invalid/u);
  });
});

