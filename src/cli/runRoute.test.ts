import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseSimfileSource } from "../schema/index.js";
import { parseRunArguments } from "./runArguments.js";
import { resolveSimfileRunRoute } from "./runRoute.js";

const source = (linked: boolean): string => `
simfile_version: "0.1"
name: route-test
${linked ? "spawnfile: ./organization/Spawnfile" : ""}
clock:
  seed: route-test
  tick: 1s
`;
const route = (linked: boolean, argv: readonly string[]) => resolveSimfileRunRoute({
  options: parseRunArguments(["/work/Simfile", ...argv]),
  simfile: parseSimfileSource(source(linked)).simfile,
  simfilePath: "/work/Simfile",
});

describe("run routing", () => {
  it("routes only an authored resolved link to composition", () => {
    assert.deepEqual(route(true, []), {
      kind: "composed", linked_spawnfile_path: "/work/organization/Spawnfile",
    });
    assert.deepEqual(route(true, ["--mode", "lifecycle-replay-smoke"]), {
      kind: "composed", linked_spawnfile_path: "/work/organization/Spawnfile",
    });
    assert.deepEqual(route(true, ["--local", "--ticks", "2"]), {
      kind: "local", linked_spawnfile_path: "/work/organization/Spawnfile",
    });
    assert.deepEqual(route(false, ["--ticks=2"]), { kind: "local" });
  });

  it("rejects every prepared/scripted input before composed dispatch", () => {
    for (const args of [
      ["--acts", "acts.json"], ["--clock", "2026-08-07T00:00:00Z"],
      ["--moltnet-artifact", "transcript"], ["--spawnfile-report", "report.json"],
    ]) assert.throws(() => route(true, args), /Linked composed runs reject/u);
    assert.throws(() => route(true, ["--ticks", "2"]), /use --local/u);
  });

  it("preserves bounded unlinked/local compatibility", () => {
    assert.throws(() => route(false, []), /require --ticks/u);
    assert.throws(() => route(true, ["--local"]), /require --ticks/u);
    assert.throws(() => route(false, ["--ticks", "1", "--view"]), /reject --view/u);
    assert.throws(() => route(false, ["--ticks", "1", "--mode", "live"]),
      /reject --mode/u);
  });
});
