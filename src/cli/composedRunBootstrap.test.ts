import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Simfile } from "../schema/index.js";
import * as compose from "../compose/index.js";
import { composedOrganizationExportLifecycleInvocationId } from "../compose/finalize-organization.js";
import {
  composedDeploymentName,
  composedHandoffRunEnvironment,
  composedOrganizationContainerName,
  composedOrganizationUnitId,
  composedProviderLifecycleInvocations,
  prepareLinkedComposedRun,
} from "./composedRunBootstrap.js";
import type { ParsedRunOptions } from "./runArguments.js";

const simfile = { clock: { seed: "neutral-seed" } } as Simfile;
const options = (root: string, overrides: Partial<ParsedRunOptions> = {}): ParsedRunOptions => ({
  local: false, outDir: path.join(root, "run"), path: path.join(root, "Simfile"),
  targetContext: "local_test", view: false, ...overrides,
});
const executable = async (file: string): Promise<void> => {
  await writeFile(file, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(file, 0o700);
};
const assertNoSupportState = async (root: string): Promise<void> => {
  await assert.rejects(access(path.join(root, ".simfile-composed")));
};
const bypassedGate = { assert_spawnfile_capabilities: async () => undefined };

test("composed organization names and handoff identity are deterministic", () => {
  const name = composedOrganizationContainerName("run-one");
  assert.match(name, /^simfile-org-[a-f0-9]{16}$/u);
  assert.equal(composedDeploymentName("run-one"), composedDeploymentName("run-one"));
  assert.equal(composedOrganizationUnitId("run-one"), `${composedDeploymentName("run-one")}-container`);
  assert.deepEqual(composedHandoffRunEnvironment("run-one"), { NOOPOLIS_RUN_ID: "run-one" });
  const invocations = composedProviderLifecycleInvocations("run-one", `sha256:${"a".repeat(64)}`);
  assert.equal(invocations.export,
    composedOrganizationExportLifecycleInvocationId(`sha256:${"a".repeat(64)}`));
});

test("compose public barrel keeps project-preparation validation private", () => {
  assert.equal("validateComposedProjectPreparation" in compose, false);
});

test("installed Spawnfile 0.1.14 fails the same read-only preflight as direct composed CLI", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simfile-bootstrap-gate-"));
  try {
    const spawnfile = path.join(root, "spawnfile");
    await writeFile(spawnfile, [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2).join(' ');",
      "if (args === '--version') process.stdout.write('0.1.14\\n');",
      "else if (args === '--help') process.stdout.write('compile target validate\\n');",
      "else if (args === 'target --help') process.stdout.write('resolve_config\\n');",
      "else if (args === 'target resolve_config --help') process.stdout.write('--evidence-destination --prepared-plan\\n');",
      "else process.exitCode = 2;",
    ].join("\n"), { mode: 0o700 });
    await chmod(spawnfile, 0o700);
    await assert.rejects(prepareLinkedComposedRun({
      environment: { PATH: root, SPAWNFILE_BIN: spawnfile },
      linked_spawnfile_path: path.join(root, "Spawnfile"), options: options(root), simfile,
      simfile_path: path.join(root, "Simfile"), source_text: "source",
    }), /evidence_export_helper_capability_unverifiable/u);
    await assertNoSupportState(root);
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("composed bootstrap never falls back to PATH for Spawnfile", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simfile-bootstrap-provider-"));
  try {
    await executable(path.join(root, "spawnfile"));
    await assert.rejects(prepareLinkedComposedRun({
      environment: { PATH: root }, linked_spawnfile_path: path.join(root, "Spawnfile"),
      options: options(root), simfile, simfile_path: path.join(root, "Simfile"), source_text: "source",
    }, bypassedGate), /SPAWNFILE_BIN must be an absolute installed executable path/u);
    await assertNoSupportState(root);
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("output and run identity are rejected before the provider seam", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simfile-bootstrap-input-"));
  try {
    await executable(path.join(root, "spawnfile"));
    await mkdir(path.join(root, "run"));
    await assert.rejects(prepareLinkedComposedRun({
      environment: { PATH: root }, linked_spawnfile_path: path.join(root, "Spawnfile"),
      options: options(root), simfile, simfile_path: path.join(root, "Simfile"), source_text: "source",
    }, bypassedGate), /output path already exists/u);
    await assert.rejects(prepareLinkedComposedRun({
      environment: { PATH: root }, linked_spawnfile_path: path.join(root, "Spawnfile"),
      options: options(root, { outDir: path.join(root, "different"), runId: "invalid run id" }),
      simfile, simfile_path: path.join(root, "Simfile"), source_text: "source",
    }, bypassedGate));
    await assertNoSupportState(root);
  } finally { await rm(root, { force: true, recursive: true }); }
});
