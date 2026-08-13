import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { runCli } from "../cli/index.js";

const captureOutput = async (operation: () => Promise<number>): Promise<{ code: number; stderr: string }> => {
  const stderr: string[] = [];
  const originalStderr = process.stderr.write;
  const originalStdout = process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return { code: await operation(), stderr: stderr.join("") };
  } finally {
    process.stderr.write = originalStderr;
    process.stdout.write = originalStdout;
  }
};

describe("dynamics CLI safety", () => {
  it("validates without executing trusted code and makes legacy run fail closed", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "simfile-dynamics-cli-"));
    try {
      const systems = path.join(directory, "systems");
      const marker = path.join(directory, "module-executed");
      const simfilePath = path.join(directory, "Simfile");
      const out = path.join(directory, "run");
      await mkdir(systems);
      await writeFile(path.join(systems, "unsafe.mjs"), `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "executed");
export const createDynamicsProvider = () => ({});
`, "utf8");
      await writeFile(simfilePath, `
simfile_version: "0.1"
name: cli-dynamics
clock:
  seed: cli-dynamics
  tick: 10ms
dynamics:
  module: ./systems/unsafe.mjs
`, "utf8");

      const validation = await captureOutput(() => runCli(["validate", simfilePath]));
      assert.equal(validation.code, 0);
      await assert.rejects(access(marker));

      const run = await captureOutput(() => runCli(["run", simfilePath, "--ticks", "1", "--out", out]));
      assert.equal(run.code, 1);
      assert.match(run.stderr, /unsupported external import: node:fs/u);
      await assert.rejects(access(marker));
      await assert.rejects(access(out));
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects unsafe config and dynamics seeds during pure validation without importing", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "simfile-dynamics-validate-"));
    try {
      const marker = path.join(directory, "module-executed");
      const simfilePath = path.join(directory, "Simfile.json");
      await mkdir(path.join(directory, "systems"));
      await writeFile(path.join(directory, "systems", "unsafe.mjs"), `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "executed");
export const createDynamicsProvider = () => ({});
`, "utf8");
      for (const [document, expected] of [[
        `{"simfile_version":"0.1","name":"unsafe-config","clock":{"seed":"validate","tick":"1s"},"dynamics":{"module":"./systems/unsafe.mjs","config":{"constructor":1}}}`,
        /safe dynamics JSON key/u
      ], [
        `{"simfile_version":"0.1","name":"unsafe-seed","clock":{"seed":${JSON.stringify("x".repeat(257))},"tick":"1s"},"dynamics":{"module":"./systems/unsafe.mjs"}}`,
        /clock\.seed.*256 code units/u
      ]] as const) {
        await writeFile(simfilePath, document, "utf8");
        const validation = await captureOutput(() => runCli(["validate", simfilePath]));
        assert.equal(validation.code, 1);
        assert.match(validation.stderr, expected);
        await assert.rejects(access(marker));
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
