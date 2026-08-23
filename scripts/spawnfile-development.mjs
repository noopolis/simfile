#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  CHECK_VERSION,
  PROBE_VERSION,
  STATE_VERSION,
  createSpawnfileCapabilityProbe,
  developmentRoot,
  fail,
  linkedExample,
  packageRoot,
  probeSpawnfileCapabilities,
  readCurrentState,
  run,
} from "./spawnfile-development-context.mjs";
import { parseSetupArguments, setupSpawnfileDevelopment } from
  "./spawnfile-development-setup.mjs";

const check = async () => {
  const state = await readCurrentState();
  const probe = state.capability_probe;
  if (!probe.development.ready) fail("Installed Spawnfile lacks required generic development commands");
  const checkRoot = await mkdtemp(path.join(developmentRoot, ".check-"));
  try {
    await run(state.bin, ["validate", linkedExample]);
    await run(state.bin, ["compile", linkedExample, "--out", path.join(checkRoot, "compiled")]);
  } finally {
    await rm(checkRoot, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify({
    capability_probe: probe,
    example: path.relative(packageRoot, linkedExample),
    example_compilation: { state: "compiled" },
    example_validation: { state: "valid" },
    version: CHECK_VERSION,
  }, null, 2)}\n`);
};

const main = async (args) => {
  const [command, ...rest] = args;
  if (command === "setup") return setupSpawnfileDevelopment(rest);
  if (command === "check" && rest.length === 0) return check();
  if (command === "status" && rest.length === 0) {
    const state = await readCurrentState();
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return;
  }
  fail("Usage: spawnfile-development.mjs <setup|check|status>");
};

export {
  CHECK_VERSION,
  PROBE_VERSION,
  STATE_VERSION,
  createSpawnfileCapabilityProbe,
  parseSetupArguments,
  probeSpawnfileCapabilities,
  readCurrentState,
  run,
};

if (process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
