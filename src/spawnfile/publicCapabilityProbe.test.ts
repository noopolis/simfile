import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSpawnfileCompositionCapabilities,
  createSpawnfilePublicCapabilityProbe,
  parseSpawnfileCapabilitiesReceipt,
  probeSpawnfilePublicCapabilities,
} from "./publicCapabilityProbe.js";

const help = {
  resolver_help: "  --evidence-destination <path>\n  --prepared-plan <path>\n",
  root_help: "  compile [options] [path]\n  target [options]\n  validate [path]\n",
  target_help: "  resolve_config [options]\n  snapshot_public_artifact <request-file>\n",
  version: "0.1.14\n",
};

const capabilityRow = (index: number) => ({
  argv: [`command-${index}`],
  invocation_versions: [],
  pending_versions: [],
  receipt_versions: ["spawnfile.generic-receipt.v1"],
  request_versions: ["spawnfile.generic-request.v1"],
  stdin_versions: [],
  stdout: { format: "json" },
});

const capabilities = (overrides: Record<string, unknown> = {}) => ({
  capabilities: {
    composed_lifecycle: {
      command_rows: Array.from({ length: 43 }, (_, index) => capabilityRow(index)),
      command_set_version: "spawnfile.composed-lifecycle-contract-set.v1",
      complete: true,
    },
    evidence_export_helper: {
      identity: "docker-image-config-digest", local_context_only: true,
      prepare_command: ["helper", "prepare-evidence-export", "--context", "<name>", "--json"],
      provisioning: "spawnfile-owned-target-local",
      receipt_version: "spawnfile.target-evidence-export-helper.prepared.v1",
      resolver_option: "--prepare-evidence-helper",
    },
    target_config_resolver: {
      command: ["target", "resolve_config"], output_version: "spawnfile.target-config-resolution.v1",
      prepared_plan_version: "spawnfile.target-config-prepared-plan.v1",
      target_config_digest_version: "spawnfile.target-config-digest.v1",
      target_config_version: "spawnfile.target-default-config.v1",
    },
    terminal_public_artifact: {
      not_present_version: "spawnfile.target-public-artifact-snapshot.not-present.v1",
      request_version: "spawnfile.target-public-artifact-snapshot.request.v1",
      snapshot_version: "spawnfile.target-public-artifact-snapshot.v1",
    },
  },
  implementation: { cli: "spawnfile", package: "spawnfile", version: "0.1.17" },
  version: "spawnfile.capabilities.v1",
  ...overrides,
});

test("legacy public capability probe fails closed on unverifiable generic semantics", () => {
  const probe = createSpawnfilePublicCapabilityProbe(help);
  assert.equal(probe.ready, false);
  assert.deepEqual(probe.blockers, [
    "generic_capabilities_receipt_unavailable",
    "evidence_export_helper_capability_unverifiable",
    "typed_terminal_not_present_capability_unverifiable",
  ]);
  assert.throws(() => assertSpawnfileCompositionCapabilities(probe),
    /generic_capabilities_receipt_unavailable/u);
});

test("capabilities receipt rejects a structurally-valid but unpinned command contract", () => {
  assert.throws(() => parseSpawnfileCapabilitiesReceipt(capabilities()),
    /command contract drifted/u);
});

test("capabilities receipt rejects incomplete rows, an incomplete set, and version drift", () => {
  const incompleteRows = capabilities();
  (incompleteRows.capabilities.composed_lifecycle.command_rows as unknown[]).pop();
  assert.throws(() => parseSpawnfileCapabilitiesReceipt(incompleteRows), /expected array/u);
  assert.throws(() => parseSpawnfileCapabilitiesReceipt(capabilities({ capabilities: {
    ...capabilities().capabilities,
    composed_lifecycle: { command_rows: Array.from({ length: 43 }, (_, index) => capabilityRow(index)),
      command_set_version: "spawnfile.composed-lifecycle-contract-set.v1", complete: false },
  } })), /true/u);
});

test("public capability probing tries capabilities JSON before legacy help fallback", async () => {
  const calls: string[] = [];
  const outputs = new Map([
    ["--version", help.version],
    ["--help", help.root_help],
    ["target --help", help.target_help],
    ["target resolve_config --help", help.resolver_help],
  ]);
  const probe = await probeSpawnfilePublicCapabilities({
    cwd: "/project",
    environment: {},
    identity: { path: "/isolated/spawnfile", sha256: `sha256:${"a".repeat(64)}` },
    run: async (args) => {
      const key = args.join(" ");
      calls.push(key);
      if (key === "capabilities --json") throw new Error("unsupported");
      return { stdout: outputs.get(key) ?? "" };
    },
  });
  assert.deepEqual(calls, [
    "--version", "capabilities --json", "--help", "target --help", "target resolve_config --help",
  ]);
  assert.equal(probe.ready, false);
});

test("capabilities JSON success uses no help inference", async () => {
  const calls: string[] = [];
  await assert.rejects(probeSpawnfilePublicCapabilities({
    cwd: "/project",
    environment: {},
    identity: { path: "/isolated/spawnfile", sha256: `sha256:${"a".repeat(64)}` },
    run: async (args) => {
      calls.push(args.join(" "));
      if (args[0] === "--version") return { stdout: "0.1.17\n" };
      return { stdout: JSON.stringify(capabilities()) };
    },
  }), /command contract drifted/u);
});
