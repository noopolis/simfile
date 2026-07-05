import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { runCli } from "./index.js";

describe("runCli", () => {
  it("validates a Simfile path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "simfile-cli-"));
    const file = path.join(dir, "Simfile.yaml");
    await writeFile(file, `
simfile_version: "0.1"
kind: simulation
name: cli-world
clock:
  tick: 1m
  phases:
    - id: day
      starts: "08:00"
actors:
  - id: eleanor
locations:
  - id: office
`, "utf8");

    const code = await runCli(["validate", file]);
    assert.equal(code, 0);
  });

  it("rejects missing paths", async () => {
    const code = await runCli(["validate"]);
    assert.equal(code, 1);
  });
});
