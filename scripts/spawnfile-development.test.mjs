import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  createSpawnfileCapabilityProbe,
  parseSetupArguments,
  probeSpawnfileCapabilities,
  run,
} from "./spawnfile-development.mjs";

const assertProcessGroupStopped = (pid) => {
  assert.throws(
    () => process.kill(-pid, 0),
    (error) => error?.code === "ESRCH",
  );
};

test("spawnfile development setup requires one explicit standalone source", () => {
  assert.deepEqual(parseSetupArguments(["--source", "/tmp/spawnfile-source"]), {
    artifact: undefined,
    packageSpec: undefined,
    sha256: undefined,
    source: "/tmp/spawnfile-source",
  });
  assert.deepEqual(parseSetupArguments(["--package", "spawnfile@0.2.0"]), {
    artifact: undefined,
    packageSpec: "spawnfile@0.2.0",
    sha256: undefined,
    source: undefined,
  });
  assert.deepEqual(parseSetupArguments(["--artifact", "/tmp/spawnfile.tgz", "--sha256", "a".repeat(64)]), {
    artifact: "/tmp/spawnfile.tgz", packageSpec: undefined, sha256: "a".repeat(64), source: undefined,
  });
  assert.throws(() => parseSetupArguments([]), /exactly one/u);
  assert.throws(() => parseSetupArguments([
    "--source", "/tmp/spawnfile-source", "--package", "spawnfile@0.2.0",
  ]), /exactly one/u);
  assert.throws(() => parseSetupArguments(["--source", "../spawnfile"]), /absolute normalized/u);
  assert.throws(() => parseSetupArguments(["--package", "spawnfile@latest"]), /exact/u);
  assert.throws(() => parseSetupArguments(["--artifact", "/tmp/spawnfile.tgz"]), /requires --sha256/u);
});

test("Simfile probes only generic Spawnfile command surfaces and fails closed", () => {
  const probe = createSpawnfileCapabilityProbe({
    resolver_help: [
      "  --evidence-destination <path>",
      "  --prepared-plan <path>",
    ].join("\n"),
    root_help: [
      "  compile [options] [path]  Compile a project",
      "  target [options]          Execute target operations",
      "  validate [path]           Validate a project",
    ].join("\n"),
    target_help: [
      "  resolve_config [options]",
      "  snapshot_public_artifact <request-file>",
    ].join("\n"),
    version: "0.1.14\n",
  });
  assert.equal(probe.development.ready, true);
  assert.equal(probe.composed.ready, false);
  assert.deepEqual(probe.composed.blockers, [
    "generic_capabilities_receipt_unavailable",
    "evidence_export_helper_capability_unverifiable",
    "typed_terminal_not_present_capability_unverifiable",
  ]);
  assert.equal(JSON.stringify(probe).includes("profile"), false);
  assert.throws(() => createSpawnfileCapabilityProbe({
    resolver_help: "", root_help: "", target_help: "", version: "latest",
  }), /semantic version/u);
});

test("generic help discovery ignores presentation indentation", () => {
  const probe = createSpawnfileCapabilityProbe({
    resolver_help: "\t--evidence-destination <path>\n --prepared-plan <path>\n",
    root_help: "compile [options] [path]\n\ttarget [options]\n validate [path]\n",
    target_help: "resolve_config [options]\n\tsnapshot_public_artifact <request-file>\n",
    version: "0.1.14",
  });
  assert.equal(probe.development.ready, true);
  assert.deepEqual(probe.composed.blockers, [
    "generic_capabilities_receipt_unavailable",
    "evidence_export_helper_capability_unverifiable",
    "typed_terminal_not_present_capability_unverifiable",
  ]);
});

test("capability probing uses generic JSON discovery before its legacy help fallback", async () => {
  const calls = [];
  const output = new Map([
    ["--version", "0.1.14\n"],
    ["--help", "  compile [options] [path]\n  target [options]\n  validate [path]\n"],
    ["target --help", "  resolve_config [options]\n  snapshot_public_artifact <request-file>\n"],
    ["target resolve_config --help", "  --evidence-destination <path>\n  --prepared-plan <path>\n"],
  ]);
  const probe = await probeSpawnfileCapabilities("/isolated/spawnfile", async (bin, args) => {
    calls.push([bin, args]);
    if (args.join(" ") === "capabilities --json") throw new Error("unsupported");
    return { stderr: "", stdout: output.get(args.join(" ")) ?? "" };
  });
  assert.deepEqual(calls, [
    ["/isolated/spawnfile", ["--version"]],
    ["/isolated/spawnfile", ["capabilities", "--json"]],
    ["/isolated/spawnfile", ["--help"]],
    ["/isolated/spawnfile", ["target", "--help"]],
    ["/isolated/spawnfile", ["target", "resolve_config", "--help"]],
  ]);
  assert.equal(probe.composed.ready, false);
  assert.equal(probe.development.ready, true);
});

test("capability probing rejects a structurally valid but unpinned JSON contract", async () => {
  const row = (index) => ({
    argv: [`command-${index}`],
    invocation_versions: [],
    pending_versions: [],
    receipt_versions: ["spawnfile.generic-receipt.v1"],
    request_versions: ["spawnfile.generic-request.v1"],
    stdin_versions: [],
    stdout: { format: "json" },
  });
  const report = {
    capabilities: {
      composed_lifecycle: {
        command_rows: Array.from({ length: 43 }, (_, index) => row(index)),
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
  };
  const calls = [];
  await assert.rejects(probeSpawnfileCapabilities("/isolated/spawnfile", async (_bin, args) => {
    calls.push(args);
    if (args.join(" ") === "--version") return { stderr: "", stdout: "0.1.17\n" };
    if (args.join(" ") === "capabilities --json") {
      return { stderr: "", stdout: JSON.stringify(report) };
    }
    throw new Error("help must not be queried after a valid JSON contract");
  }), /command contract drifted/u);
  assert.deepEqual(calls, [["--version"], ["capabilities", "--json"]]);
});

test("missing nested generic help remains a structured fail-closed result", async () => {
  const probe = await probeSpawnfileCapabilities("/isolated/spawnfile", async (_bin, args) => {
    if (args.join(" ") === "--version") return { stderr: "", stdout: "0.1.14\n" };
    if (args.join(" ") === "--help") {
      return {
        stderr: "",
        stdout: "  compile [options] [path]\n  target [options]\n  validate [path]\n",
      };
    }
    throw new Error("unsupported generic discovery command");
  });
  assert.equal(probe.composed.ready, false);
  assert.deepEqual(probe.composed.blockers.slice(0, 4), [
    "generic_command_unavailable:resolve_config",
    "generic_command_unavailable:snapshot_public_artifact",
    "generic_resolver_option_unavailable:evidence_destination",
    "generic_resolver_option_unavailable:prepared_plan",
  ]);
});

test("development subprocess timeout quiesces a hostile process group before settling", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "simfile-development-timeout-"));
  const marker = path.join(root, "late-marker");
  const pidFile = path.join(root, "group-pid");
  const descendant = [
    "process.on('SIGTERM', () => {});",
    `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "late"), 1250);`,
    "setInterval(() => {}, 1000);",
  ].join(" ");
  const parent = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "inherit" }); setInterval(() => {}, 1000);`;
  try {
    await assert.rejects(run(process.execPath, ["-e", parent], { timeoutMs: 100 }),
      /exceeded its 100ms timeout/u);
    assertProcessGroupStopped(Number(await readFile(pidFile, "utf8")));
    await delay(500);
    await assert.rejects(access(marker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("development output overflow quiesces a hostile process group before settling", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "simfile-development-output-"));
  const marker = path.join(root, "late-marker");
  const pidFile = path.join(root, "group-pid");
  const descendant = [
    "process.on('SIGTERM', () => {});",
    "process.send?.('ready');",
    `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "late"), 2000);`,
    "setInterval(() => {}, 1000);",
  ].join(" ");
  const parent = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); const descendant = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", "inherit", "inherit", "ipc"] }); descendant.once("message", () => process.stdout.write("x".repeat(2048))); setInterval(() => {}, 1000);`;
  try {
    await assert.rejects(run(process.execPath, ["-e", parent], {
      maxOutputBytes: 1_024,
      timeoutMs: 5_000,
    }), /bounded output limit/u);
    assertProcessGroupStopped(Number(await readFile(pidFile, "utf8")));
    await delay(500);
    await assert.rejects(access(marker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
