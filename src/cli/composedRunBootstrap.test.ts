import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Simfile } from "../schema/index.js";
import { composedOrganizationExportLifecycleInvocationId } from
  "../compose/finalize-organization.js";
import {
  composedDeploymentName,
  composedHandoffRunEnvironment,
  composedProviderLifecycleInvocations,
  composedOrganizationContainerName,
  composedOrganizationUnitId,
  prepareLinkedComposedRun,
} from "./composedRunBootstrap.js";
import type { ParsedRunOptions } from "./runArguments.js";

const simfile = { clock: { seed: "neutral-seed" } } as Simfile;
const options = (root: string, overrides: Partial<ParsedRunOptions> = {}): ParsedRunOptions => ({
  local: false, outDir: path.join(root, "run"), path: path.join(root, "Simfile"),
  view: false, ...overrides,
});

test("composed organization container names are deterministic DNS labels", () => {
  const name = composedOrganizationContainerName("run-one");
  assert.match(name, /^simfile-org-[a-f0-9]{16}$/u);
  assert.equal(name, composedOrganizationContainerName("run-one"));
});

test("composed deployment names are deterministic Spawnfile identifiers", () => {
  const name = composedDeploymentName("run-one");
  assert.match(name, /^simfile-[a-f0-9]{16}$/u);
  assert.equal(name, composedDeploymentName("run-one"));
  assert.doesNotMatch(name, /_/u);
  assert.equal(composedOrganizationUnitId("run-one"), `${name}-container`);
});

test("composed handoff environment correlates the exact authorized run identity", () => {
  assert.deepEqual(composedHandoffRunEnvironment("run-one"), {
    NOOPOLIS_RUN_ID: "run-one",
  });
  assert.throws(() => composedHandoffRunEnvironment("invalid run id"));
});

test("composed bootstrap persists the finalizer's exact export lifecycle identity", () => {
  const requestDigest = `sha256:${"a".repeat(64)}`;
  const invocations = composedProviderLifecycleInvocations("run-one", requestDigest);
  assert.equal(invocations.export,
    composedOrganizationExportLifecycleInvocationId(requestDigest));
  assert.notEqual(invocations.export, invocations.up);
  assert.notEqual(invocations.export, invocations.down);
});

test("composed bootstrap rejects occupied output before creating support state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simfile-bootstrap-preflight-"));
  try {
    await mkdir(path.join(root, "run"));
    await assert.rejects(prepareLinkedComposedRun({
      linked_spawnfile_path: path.join(root, "Spawnfile"), options: options(root),
      simfile, simfile_path: path.join(root, "Simfile"), source_text: "source",
    }), /output path already exists/u);
    await assert.rejects(access(path.join(root, ".simfile-composed")));
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("composed bootstrap validates run identity before lifecycle prerequisites", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simfile-bootstrap-identity-"));
  try {
    await assert.rejects(prepareLinkedComposedRun({
      linked_spawnfile_path: path.join(root, "Spawnfile"),
      options: options(root, { runId: "invalid run id" }), simfile,
      simfile_path: path.join(root, "Simfile"), source_text: "source",
    }));
    await assert.rejects(access(path.join(root, ".simfile-composed")));
  } finally { await rm(root, { force: true, recursive: true }); }
});
