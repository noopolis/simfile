import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { reconcileEvents } from "@noopolis/stele";

import {
  createDynamicsTestProject,
  removeDynamicsTestProject
} from "../dynamics/testSupport.test-helper.js";
import { buildObserveReport } from "./compute.js";
import {
  parseRunManifest,
  RUN_MANIFEST_VERSION,
  type SimfileRunManifest
} from "./manifest.js";
import {
  OBSERVE_REPORT_VERSION,
  parseObserveReport,
  type SimfileObserveReport
} from "./report.js";
import type { ObserveWorldGrants } from "./worldGrants.js";

const packageRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const savedReportPath = path.join(
  packageRoot,
  "fixtures",
  "observe",
  "office-pressure-v0-golden",
  "observe",
  "report.json"
);
const savedRunPath = path.resolve(savedReportPath, "..", "..");

const captureCli = async (
  argv: readonly string[]
): Promise<{ code: number; stderr: string; stdout: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      fileURLToPath(new URL("../cli/index.ts", import.meta.url)),
      ...argv
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({
      code: code ?? 1,
      stderr: Buffer.concat(stderr).toString(),
      stdout: Buffer.concat(stdout).toString()
    }));
  });

const manifestFor = (world?: Record<string, unknown>): SimfileRunManifest =>
  parseRunManifest({
    version: RUN_MANIFEST_VERSION,
    run_id: "observe-world-grants",
    created_at: "2026-07-30T00:00:00.000Z",
    contract_versions: {},
    artifacts: [],
    ...(world === undefined ? {} : { world })
  });

const reportFor = (manifest: SimfileRunManifest): SimfileObserveReport =>
  buildObserveReport({
    allEvents: [],
    manifest,
    memoryBanks: [],
    reconciled: reconcileEvents([])
  });

const grantStates: readonly ObserveWorldGrants[] = [
  {
    status: "none-declared",
    participants: [],
    resolved: false,
    observed: false,
    deferred_to: "B158"
  },
  {
    status: "declared-unresolved",
    participants: ["alpha", "beta"],
    resolved: false,
    observed: false,
    deferred_to: "B158"
  },
  {
    status: "declared-resolved",
    participants: ["alpha", "beta"],
    resolved: true,
    observed: true
  }
];

test("all three recorded world-grant states round-trip as distinguishable report evidence", () => {
  const reports = grantStates.map((marker) =>
    parseObserveReport(reportFor(manifestFor({ world_grants: marker })))
  );

  assert.deepEqual(
    reports.map((report) => report.world_grants),
    grantStates
  );
  assert.deepEqual(
    reports.map((report) => report.world_grants?.status),
    ["none-declared", "declared-unresolved", "declared-resolved"]
  );
  assert.equal(new Set(reports.map((report) => report.world_grants?.status)).size, 3);
});

test("a missing marker remains absent and distinct from none-declared", () => {
  const absent = parseObserveReport(reportFor(manifestFor({ decision_source: "none" })));
  const noneDeclared = parseObserveReport(reportFor(manifestFor({
    world_grants: grantStates[0]
  })));

  assert.equal(Object.hasOwn(absent, "world_grants"), false);
  assert.equal(absent.world_grants, undefined);
  assert.equal(Object.hasOwn(noneDeclared, "world_grants"), true);
  assert.equal(noneDeclared.world_grants?.status, "none-declared");
});

test("a malformed recorded marker fails loudly and names the offending field", () => {
  const manifest = manifestFor({
    world_grants: {
      status: "declared-unresolved",
      participants: ["alpha"],
      resolved: "not-a-boolean",
      observed: false
    }
  });

  assert.throws(
    () => reportFor(manifest),
    /invalid manifest world\.world_grants marker: world\.world_grants\.resolved:/u
  );
});

test("a committed saved v1 report without world_grants remains valid", async () => {
  const saved = JSON.parse(await readFile(savedReportPath, "utf8")) as unknown;
  assert.equal(
    Object.hasOwn(saved as Record<string, unknown>, "world_grants"),
    false
  );

  const parsed = parseObserveReport(saved);
  assert.equal(parsed.version, "simfile.observe.v1");
  assert.equal(parsed.world_grants, undefined);
  assert.equal(OBSERVE_REPORT_VERSION, "simfile.observe.v1");
});

test("spawned run and observe commands surface B157 markers in JSON and plain output", async () => {
  const declaredProject = await createDynamicsTestProject();
  const undeclaredProject = await createDynamicsTestProject();
  try {
    const declaredSource = await readFile(declaredProject.simfilePath, "utf8");
    await writeFile(declaredProject.simfilePath, `${declaredSource}
world:
  id: grant-observe
  grants:
    beta:
      entity: entity:beta
    alpha:
      entity: entity:alpha
`, "utf8");

    const variants = [
      {
        name: "declared",
        project: declaredProject,
        expected: {
          status: "declared-unresolved",
          participants: ["alpha", "beta"],
          resolved: false,
          observed: false
        },
        plain: "world grants: declared-unresolved (resolved=false, observed=false, participants: alpha, beta)"
      },
      {
        name: "undeclared",
        project: undeclaredProject,
        expected: {
          status: "none-declared",
          participants: [],
          resolved: false,
          observed: false
        },
        plain: "world grants: none-declared (resolved=false, observed=false, participants: none)"
      }
    ] as const;

    for (const variant of variants) {
      const runDirectory = path.join(variant.project.directory, `${variant.name}-run`);
      const run = await captureCli([
        "run",
        variant.project.simfilePath,
        "--ticks",
        "1",
        "--out",
        runDirectory,
        "--run-id",
        `${variant.name}-grants`
      ]);
      assert.equal(run.code, 0, run.stderr);
      assert.equal(run.stderr, "");

      const jsonObserve = await captureCli(["observe", runDirectory, "--json"]);
      assert.equal(jsonObserve.code, 0, jsonObserve.stderr);
      assert.equal(jsonObserve.stderr, "");
      const payload = JSON.parse(jsonObserve.stdout) as {
        report: { world_grants?: ObserveWorldGrants };
      };
      assert.deepEqual(payload.report.world_grants, variant.expected);

      const plainObserve = await captureCli(["observe", runDirectory]);
      assert.equal(plainObserve.code, 0, plainObserve.stderr);
      assert.equal(plainObserve.stderr, "");
      assert.equal(plainObserve.stdout.split("\n").includes(variant.plain), true);
    }
  } finally {
    await Promise.all([
      removeDynamicsTestProject(declaredProject),
      removeDynamicsTestProject(undeclaredProject)
    ]);
  }
});

test("plain output distinguishes a pre-marker run as not recorded", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "simfile-observe-pre-marker-"));
  const copiedRun = path.join(temporaryRoot, "run");
  try {
    await cp(savedRunPath, copiedRun, { recursive: true });
    const observed = await captureCli(["observe", copiedRun]);
    assert.equal(observed.code, 0, observed.stderr);
    assert.equal(observed.stderr, "");
    assert.equal(observed.stdout.split("\n").includes("world grants: not recorded"), true);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});
