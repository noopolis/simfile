import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { writeRunRecord } from "../runtime/trace.js";
import { parseSimfileSource } from "../schema/parse.js";
import { executeSimfileRun } from "./run-driver.js";

const traceSource = `
simfile_version: "0.1"
name: trace-driver
clock:
  seed: trace-seed
  tick: 1s
variables:
  value:
    scope: global
    initial: 0
    range: 0..2
generators:
  rise:
    kind: deterministic
    variable: value
    delta: 0.5
`;

const dynamicsSource = (extra = "") => `
simfile_version: "0.1"
name: dynamics-driver
clock:
  seed: dynamics-seed
  tick: 1s
${extra}
dynamics:
  module: ./systems/missing.mjs
`;

const fixedClock = () => new Date("2026-01-02T03:04:05.000Z");

const files = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested: string[] = [];
  for (const entry of entries) {
    const relative = entry.name;
    if (entry.isDirectory()) {
      for (const child of await files(path.join(directory, entry.name))) {
        nested.push(path.join(relative, child));
      }
    } else {
      nested.push(relative);
    }
  }
  return nested.sort();
};

describe("executeSimfileRun", () => {
  it("T4 keeps non-dynamics records byte-identical to direct writeRunRecord", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-run-driver-trace-"));
    try {
      const simfilePath = path.join(root, "Simfile");
      const directOut = path.join(root, "direct");
      const dispatchOut = path.join(root, "dispatch");
      const simfile = parseSimfileSource(traceSource, { path: simfilePath }).simfile;
      const common = {
        runId: "trace-run",
        seed: "trace-seed",
        simfile,
        sourceText: traceSource,
        ticks: 3,
        clock: fixedClock
      };
      await writeRunRecord({
        ...common,
        outDir: directOut,
        sourcePath: simfilePath
      });
      const result = await executeSimfileRun({
        ...common,
        outDir: dispatchOut,
        simfilePath
      });
      assert.equal(result.driver, "trace");
      const layout = await files(directOut);
      assert.deepEqual(await files(dispatchOut), layout);
      for (const relative of layout) {
        assert.deepEqual(
          await readFile(path.join(dispatchOut, relative)),
          await readFile(path.join(directOut, relative))
        );
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("T5a/T5b preserves trace --acts read and parse failures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-run-driver-acts-"));
    try {
      const simfilePath = path.join(root, "Simfile");
      const simfile = parseSimfileSource(traceSource, { path: simfilePath }).simfile;
      const base = {
        outDir: path.join(root, "out"),
        runId: "trace-run",
        seed: "trace-seed",
        simfile,
        simfilePath,
        sourceText: traceSource,
        ticks: 1,
        clock: fixedClock
      };
      const missing = path.join(root, "missing.json");
      await assert.rejects(
        executeSimfileRun({ ...base, actsPath: missing }),
        (error: NodeJS.ErrnoException) =>
          error.code === "ENOENT" && error.message.includes(missing)
      );
      const nonArray = path.join(root, "non-array.json");
      await writeFile(nonArray, "{}", "utf8");
      await assert.rejects(
        executeSimfileRun({ ...base, actsPath: nonArray }),
        new Error(`--acts file must contain a JSON array: ${nonArray}`)
      );
      const malformed = path.join(root, "malformed.json");
      await writeFile(malformed, "{", "utf8");
      await assert.rejects(
        executeSimfileRun({ ...base, actsPath: malformed }),
        SyntaxError
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a malformed project viewer declaration before output", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-run-driver-viewer-"));
    try {
      const simfilePath = path.join(root, "Simfile");
      const outDir = path.join(root, "out");
      const simfile = parseSimfileSource(traceSource, { path: simfilePath }).simfile;
      await writeFile(path.join(root, "viewer-extensions.json"), JSON.stringify({
        version: "simfile.project-viewer-extensions.v1",
        extensions: [{ descriptor: "../escape.json", id: "renderer" }],
      }));
      await assert.rejects(executeSimfileRun({
        outDir,
        runId: "trace-run",
        seed: "trace-seed",
        simfile,
        simfilePath,
        sourceText: traceSource,
        ticks: 1,
        clock: fixedClock,
      }), /invalid simfile\.project-viewer-extensions\.v1 declaration/u);
      await assert.rejects(access(outDir));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("T5c/T5d rejects dynamics --acts before reading or writing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-run-driver-dyn-acts-"));
    try {
      const simfilePath = path.join(root, "Simfile");
      const source = dynamicsSource();
      const simfile = parseSimfileSource(source, { path: simfilePath }).simfile;
      for (const actsPath of [
        path.join(root, "missing.json"),
        path.join(root, "malformed.json")
      ]) {
        if (actsPath.endsWith("malformed.json")) {
          await writeFile(actsPath, "{", "utf8");
        }
        const outDir = path.join(root, path.basename(actsPath, ".json"));
        await assert.rejects(
          executeSimfileRun({
            actsPath,
            outDir,
            runId: "dynamics-run",
            seed: "dynamics-seed",
            simfile,
            simfilePath,
            sourceText: source,
            ticks: 1,
            clock: fixedClock
          }),
          /--acts supplies trace-protocol variable acts/u
        );
        await assert.rejects(access(outDir));
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("T6 rejects dynamics Moltnet artifacts before output work", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-run-driver-moltnet-"));
    try {
      const simfilePath = path.join(root, "Simfile");
      const outDir = path.join(root, "out");
      const source = dynamicsSource();
      const simfile = parseSimfileSource(source, { path: simfilePath }).simfile;
      await assert.rejects(executeSimfileRun({
        moltnetArtifact: "transcript",
        outDir,
        runId: "dynamics-run",
        seed: "dynamics-seed",
        simfile,
        simfilePath,
        sourceText: source,
        ticks: 1,
        clock: fixedClock
      }), /--moltnet-artifact derives from trace events/u);
      await assert.rejects(access(outDir));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("T-guard rejects mixed declarations in sorted order before output", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-run-driver-mixed-"));
    try {
      const simfilePath = path.join(root, "Simfile");
      const outDir = path.join(root, "out");
      const source = dynamicsSource(`
variables:
  value:
    scope: global
    initial: 0
    range: 0..2
generators:
  rise:
    kind: deterministic
    variable: value
    delta: 0.5`);
      const simfile = parseSimfileSource(source, { path: simfilePath }).simfile;
      await assert.rejects(executeSimfileRun({
        outDir, runId: "mixed", seed: "dynamics-seed", simfile,
        simfilePath, sourceText: source, ticks: 1, clock: fixedClock
      }), /trace mechanics \(generators, variables\)/u);
      await assert.rejects(access(outDir));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("T-guard-phases rejects non-empty dynamics phases before output", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-run-driver-phases-"));
    try {
      const simfilePath = path.join(root, "Simfile");
      const outDir = path.join(root, "out");
      const source = dynamicsSource("  phases:\n    day: \"08:00\"");
      const simfile = parseSimfileSource(source, { path: simfilePath }).simfile;
      await assert.rejects(executeSimfileRun({
        outDir, runId: "phases", seed: "dynamics-seed", simfile,
        simfilePath, sourceText: source, ticks: 1, clock: fixedClock
      }), /trace mechanics \(clock\.phases\)/u);
      await assert.rejects(access(outDir));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
