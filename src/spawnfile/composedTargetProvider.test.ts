import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createBootstrapComposedPhaseJournal,
  type ComposedJournalSession,
} from "../compose/index.js";
import { digestComposedJson } from "../compose/json.js";
import { currentTargetOperation } from "../compose/operationJournal.js";
import { captureBootstrapLocalExecutableIdentity } from "./process.js";
import { createCliComposedTargetProvider } from "./composedTargetProvider.js";

const sha = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
const request = {
  descriptor_digest: sha("a"), expected_revision: 7,
  idempotency_key: "idem_aaaaaaaaaaaaaaaa", operation: "create_world_service",
  run_id: "run-target-crash", selected_target: {
    fingerprint: `sha256:${"b".repeat(32)}`, handle: "opaque_bbbbbbbbbbbbbbbb",
  }, version: "spawnfile.target-resource.request.v1",
} as const;
const requestDigest = digestComposedJson("spawnfile.target-resource.request.v1", request);
const receipt = { operation: request.operation,
  operation_handle: "opaque_cccccccccccccccc", request_digest: requestDigest } as const;

const session = (root: string): ComposedJournalSession => {
  const runRequest = {
    descriptor_digest: sha("a"), mode: "live",
    organization: { artifact_digest: sha("b"), source_digest: sha("c"),
      world_bindings_digest: sha("d") },
    required_world_capabilities: ["simfile.world-decision-claim.v1"],
    run_id: request.run_id, source_digest: sha("e"),
    target: { auth_profile: "scripted-no-model-auth", selector: "local_test" },
    version: "simfile.composed-run-request.v1",
    world: { artifact_manifest_digest: sha("f"), bundle_digest: sha("1"),
      runtime_abi: "simfile.world-sidecar-runtime.v1" },
  } as const;
  let journal = createBootstrapComposedPhaseJournal(runRequest, {
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
  }, "2026-08-16T00:00:00.000Z");
  return { path: path.join(root, "journal.json"), assertCurrent: async () => undefined,
    current: () => journal, replace: async (expected, next) => {
      assert.equal(expected.journal_digest, journal.journal_digest); journal = next;
    } };
};

test("target crash window returns lookup truth for explicit completion without reinvoking", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simfile-target-crash-"));
  try {
    const calls = path.join(root, "calls");
    const executable = path.join(root, "spawnfile.mjs");
    await writeFile(executable, `import { appendFile, readFile } from "node:fs/promises";\nconst argv = process.argv.slice(2); const command = argv[3]; const request = JSON.parse(await readFile(argv[4], "utf8")); await appendFile(process.env.CALLS, command + "\\n"); const receipt = ${JSON.stringify(receipt)}; if (command === "lookup_operation") process.stdout.write(JSON.stringify({ idempotency_key: request.idempotency_key, operation: request.operation, operation_handle: receipt.operation_handle, receipt, request_digest: receipt.request_digest, status: "completed", version: "spawnfile.target-resource.operation-lookup.v1" })); else process.stdout.write(JSON.stringify(receipt));\n`, { mode: 0o700 });
    const journalSession = session(root);
    const context = { bootstrapLocalExecutableIdentity:
      await captureBootstrapLocalExecutableIdentity(executable),
    env: { ...process.env, CALLS: calls }, spawnfileBin: executable };
    const provider = await createCliComposedTargetProvider({ base_image: "node:22-bookworm-slim",
      context, docker_command: "docker", evidence_destination: path.join(root, "world.tar"),
      local_context: "local_test", prepared_plan: path.join(root, "plan"),
      resolved_resolution: { config_bytes: new TextEncoder().encode("{}"), identity: {
        base_image: { config_digest: sha("4"), reference: "node:22-bookworm-slim" },
        context: "local_test", endpoint_transport: "unix",
        platform: { architecture: "amd64", os: "linux" },
        prepared_evidence_helper: { digest: sha("5"), handle: "opaque_dddddddddddddddd",
          version: "spawnfile.target-evidence-export-helper.prepared.v1" },
        target_config_digest: sha("6"), version: "spawnfile.target-config-resolution.v1" } } });
    const signal = new AbortController().signal;
    assert.deepEqual(await provider.request({ command: request.operation,
      journal_session: journalSession, request, signal }), receipt);
    assert.equal(currentTargetOperation(journalSession.current(), request.operation, request)?.state,
      "intent_durable");
    const recovered = await provider.request({ command: request.operation,
      journal_session: journalSession, request, signal }) as typeof receipt;
    assert.deepEqual(recovered, receipt);
    assert.equal(currentTargetOperation(journalSession.current(), request.operation, request)?.state,
      "intent_durable");
    await provider.complete({ command: request.operation, journal_session: journalSession,
      receipt: recovered, request });
    assert.equal(currentTargetOperation(journalSession.current(), request.operation, request)?.state,
      "completed");
    await provider.complete({ command: request.operation, journal_session: journalSession,
      receipt: recovered, request });
    await assert.rejects(provider.complete({ command: request.operation,
      journal_session: journalSession, receipt: { ...recovered,
        operation_handle: "opaque_eeeeeeeeeeeeeeee" }, request }), /receipt changed/u);
    assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n"),
      [request.operation, "lookup_operation"]);
    provider.close();
  } finally { await rm(root, { force: true, recursive: true }); }
});
