import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { LinkedComposedRunInput } from "./composedRunCommand.js";
import { runCli } from "./index.js";

const project = async (): Promise<{ directory: string; simfile: string }> => {
  const directory = await mkdtemp(path.join(tmpdir(), "simfile-composed-route-"));
  const simfile = path.join(directory, "Simfile");
  await writeFile(path.join(directory, "Spawnfile"), "kind: agent\n", "utf8");
  await writeFile(simfile, `
simfile_version: "0.1"
name: composed-route
spawnfile: ./Spawnfile
clock:
  seed: composed-route
  tick: 1s
`, "utf8");
  return { directory, simfile };
};

describe("linked composed CLI dispatch", () => {
  it("passes existing composed flags and the resolved link to one command", async () => {
    const fixture = await project();
    let seen: LinkedComposedRunInput | undefined;
    const code = await runCli([
      "run", fixture.simfile, "--view", "--out=record", "--seed", "alternate",
      "--run-id=run-one",
    ], { runComposed: async (input) => { seen = input; return 0; } });
    assert.equal(code, 0);
    assert.equal(seen?.linked_spawnfile_path, path.join(fixture.directory, "Spawnfile"));
    assert.equal(seen?.options.view, true);
    assert.equal(seen?.options.outDir, "record");
    assert.equal(seen?.options.seed, "alternate");
    assert.equal(seen?.options.runId, "run-one");
  });

  it("rejects incompatible flags before invoking or creating output", async () => {
    const fixture = await project();
    for (const args of [
      ["--ticks", "1"], ["--acts=acts.json"], ["--clock=2026-08-07T00:00:00Z"],
      ["--moltnet-artifact=delivery"], ["--spawnfile-report=report.json"],
    ]) {
      let invoked = false;
      const out = path.join(fixture.directory, `out-${args[0]!.slice(2, 8)}`);
      assert.equal(await runCli(["run", fixture.simfile, "--out", out, ...args], {
        runComposed: async () => { invoked = true; return 0; },
      }), 1);
      assert.equal(invoked, false);
      await assert.rejects(stat(out));
    }
  });
});

