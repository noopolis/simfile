import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createBootstrapComposedPhaseJournal,
  type ComposedJournalSession,
} from "../compose/index.js";
import {
  currentBootstrapOperation,
  journalBootstrapOperationIntent,
  journalBootstrapOperationObservation,
} from "../compose/bootstrapOperationJournal.js";
import { captureBootstrapLocalExecutableIdentity } from "./process.js";
import { provisionJournaledCredentials } from "./journaledCredentialProvisioning.js";

const sha = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
const request = {
  descriptor_digest: sha("a"), mode: "live",
  organization: { artifact_digest: sha("b"), source_digest: sha("c"),
    world_bindings_digest: sha("d") },
  required_world_capabilities: ["simfile.world-decision-claim.v1"],
  run_id: "run-credential-crash", source_digest: sha("e"),
  target: { auth_profile: "scripted-no-model-auth", selector: "local_test" },
  version: "simfile.composed-run-request.v1",
  world: { artifact_manifest_digest: sha("f"), bundle_digest: sha("1"),
    runtime_abi: "simfile.world-sidecar-runtime.v1" },
} as const;

const capsule = (root: string) => ({
  command_mode: "lifecycle-replay-smoke",
  paths: { compiled: path.join(root, "compiled"), env_file: path.join(root, "env"),
    grants_file: path.join(root, "grants"), journal: path.join(root, "journal.json"),
    organization_evidence: path.join(root, "org-evidence"),
    organization_path: "/tmp/project/Spawnfile",
    preflight_report: path.join(root, "preflight-report.json"),
    prepared_plan: path.join(root, "plan"),
    run: "/tmp/run", selected_target_file: path.join(root, "selected"),
    simfile: "/tmp/project/Simfile", support_root: root,
    world_bindings_file: path.join(root, "bindings"),
    world_evidence: path.join(root, "world-evidence"),
    world_evidence_archive: path.join(root, "world.tar") },
  project: { compile_fingerprint: "sf1:aaaaaaaaaaaa", descriptor_digest: sha("a"),
    preflight_report_digest: sha("0"), seed: "seed",
    simfile_source_digest: sha("e"), spawnfile_source_digest: sha("c") },
  provider: { base_image: "node:22-bookworm-slim", capability_contract_digest: sha("2"),
    context: "local_test", docker_command: "docker",
    process_environment: { NOOPOLIS_RUN_ID: request.run_id,
      SPAWNFILE_HOME: path.join(root, "auth") },
    spawnfile_bin: "/tmp/install/spawnfile", spawnfile_cwd: "/tmp/project",
    spawnfile_executable_sha256: sha("3"), spawnfile_package_version: "0.1.17" },
  run_id: request.run_id, version: "simfile.composed-bootstrap-capsule.v2",
} as const);

const sessionWithPrerequisites = (root: string): ComposedJournalSession => {
  let journal = createBootstrapComposedPhaseJournal(
    request, capsule(root), "2026-08-16T00:00:00.000Z",
  );
  for (const kind of ["resolve_target_config", "select_target",
    "prepare_container_bundle"] as const) {
    journal = journalBootstrapOperationIntent(journal, kind, { kind });
    const operation = currentBootstrapOperation(journal, kind)!;
    journal = journalBootstrapOperationObservation(
      journal, operation.operation_id, "completed", { kind },
    );
  }
  return {
    path: path.join(root, "journal.json"),
    assertCurrent: async () => undefined,
    current: () => journal,
    replace: async (expected, next) => {
      assert.equal(expected.journal_digest, journal.journal_digest);
      journal = next;
    },
  };
};

test("credential crash becomes durable ambiguity and is never reinvoked", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simfile-credential-crash-"));
  try {
    const calls = path.join(root, "calls");
    const executable = path.join(root, "spawnfile.mjs");
    await writeFile(executable, `import { appendFile } from "node:fs/promises";\nawait appendFile(process.env.CALLS, "called\\n");\nprocess.exitCode = 1;\n`, { mode: 0o700 });
    const envFile = path.join(root, "env");
    const grantsFile = path.join(root, "grants");
    const bindingsFile = path.join(root, "bindings");
    await Promise.all([envFile, grantsFile, bindingsFile].map((file) => writeFile(file, "{}")));
    const session = sessionWithPrerequisites(root);
    const input = { context: {
      bootstrapLocalExecutableIdentity: await captureBootstrapLocalExecutableIdentity(executable),
      env: { ...process.env, CALLS: calls }, spawnfileBin: executable,
    }, env_file: envFile, journal_session: session,
    request: { run_id: request.run_id, version: "credential-request.v1" },
    resolved_grants_file: grantsFile, world_bindings_file: bindingsFile };
    await assert.rejects(provisionJournaledCredentials(input));
    assert.equal(currentBootstrapOperation(
      session.current(), "provision_credentials",
    )?.state, "ambiguous");
    await assert.rejects(provisionJournaledCredentials(input), /operator reconciliation/u);
    assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
