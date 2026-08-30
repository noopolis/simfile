import assert from "node:assert/strict";
import test from "node:test";

import {
  bindComposedJournalExecution,
  createBootstrapComposedPhaseJournal,
} from "./journal.js";
import { createComposedBootstrapBinding, composedBootstrapDigest } from
  "./bootstrapAuthority.js";
import { COMPOSED_EXECUTION_VERSION } from "./execution.js";
import { digestComposedJson } from "./json.js";
import {
  journalBootstrapOperationIntent,
  journalBootstrapOperationObservation,
} from "./bootstrapOperationJournal.js";

const sha = (character: string): `sha256:${string}` =>
  `sha256:${character.repeat(64).slice(0, 64)}`;
const request = {
  descriptor_digest: sha("a"), mode: "live",
  organization: { artifact_digest: sha("b"), source_digest: sha("c"),
    world_bindings_digest: sha("d") },
  required_world_capabilities: ["simfile.world-decision-claim.v1"],
  run_id: "run-bootstrap", source_digest: sha("e"),
  target: { auth_profile: "scripted-no-model-auth", selector: "local_test" },
  version: "simfile.composed-run-request.v1",
  world: { artifact_manifest_digest: sha("f"), bundle_digest: sha("1"),
    runtime_abi: "simfile.world-sidecar-runtime.v1" },
} as const;
const capsule = {
  command_mode: "lifecycle-replay-smoke",
  paths: { compiled: "/tmp/bootstrap/compiled", env_file: "/tmp/bootstrap/env",
    grants_file: "/tmp/bootstrap/grants", journal: "/tmp/bootstrap/journal.json",
    organization_evidence: "/tmp/bootstrap/org-evidence",
    organization_path: "/tmp/project/Spawnfile",
    preflight_report: "/tmp/bootstrap/preflight-report.json",
    prepared_plan: "/tmp/bootstrap/plan",
    run: "/tmp/run", selected_target_file: "/tmp/bootstrap/selected",
    simfile: "/tmp/project/Simfile", support_root: "/tmp/bootstrap",
    world_bindings_file: "/tmp/bootstrap/bindings",
    world_evidence: "/tmp/bootstrap/world-evidence",
    world_evidence_archive: "/tmp/bootstrap/world.tar" },
  project: { compile_fingerprint: "sf1:aaaaaaaaaaaa", descriptor_digest: sha("a"),
    preflight_report_digest: sha("0"), seed: "seed",
    simfile_source_digest: sha("e"), spawnfile_source_digest: sha("c") },
  provider: { base_image: "node:22-bookworm-slim",
    capability_contract_digest: sha("2"), context: "local_test", docker_command: "docker",
    process_environment: { NOOPOLIS_RUN_ID: "run-bootstrap",
      SPAWNFILE_HOME: "/tmp/bootstrap/auth" },
    spawnfile_bin: "/tmp/install/spawnfile", spawnfile_cwd: "/tmp/project",
    spawnfile_executable_sha256: sha("3"), spawnfile_package_version: "0.1.17" },
  run_id: "run-bootstrap", version: "simfile.composed-bootstrap-capsule.v2",
} as const;
const selected = { fingerprint: `sha256:${"4".repeat(32)}`,
  handle: "opaque_aaaaaaaaaaaaaaaa" } as const;
const helper = { digest: sha("5"), handle: "opaque_bbbbbbbbbbbbbbbb",
  version: "spawnfile.target-evidence-export-helper.prepared.v1" } as const;
const execution = {
  configuration: { organization_expectation: { deployment_name: "organization_unit",
    member_engines: { smoke: "scripted" }, moltnet_release: { architecture: "amd64",
      asset_sha256: sha("6"), release_version: "v1", source_revision: "7".repeat(40) },
    selected_target_receipt_digest: sha("8"), unit_id: "organization_unit_container",
    world_binding_digest: request.organization.world_bindings_digest },
  readiness_expectation: { artifact_digest: sha("9"), bundle_digest: request.world.bundle_digest,
    capability_manifest_digests: [sha("a")], mechanics_sha256: sha("b"),
    normalized_checkpoint_sha256: sha("c"), run_id: request.run_id,
    world_instance_id: "bootstrap-world" }, terminal_tick: 4,
  topology_expectation: { selected_target: selected } },
  provider: { compiled_output_directory: "/tmp/bootstrap/compiled",
    evidence_destination_directory: "/tmp/bootstrap/evidence",
    evidence_mount_path: "/var/lib/simfile/evidence",
    lifecycle_invocations: { down: "lci_down_aaaaaaaaaaaa", export: "lci_export_aaaaaaaaaa",
      up: "lci_up_aaaaaaaaaaaaaa" }, organization_handoff: {
      env_file: "/tmp/bootstrap/env", selected_target_receipt_file: "/tmp/bootstrap/selected",
      world_bindings_file: "/tmp/bootstrap/bindings" },
    organization_container_name: "organization_unit", organization_image_tag: "organization:run",
    organization_path: "/tmp/project/Spawnfile", spawnfile_bin: "/tmp/install/spawnfile",
    spawnfile_cwd: "/tmp/project", spawnfile_executable_sha256: sha("3"),
    target_resolution: { base_image: { config_digest: sha("d"), reference: "node:22-bookworm-slim" },
      context: "local_test", endpoint_transport: "unix", platform: { architecture: "amd64", os: "linux" },
      prepared_evidence_helper: helper, target_config_digest: sha("e"),
      version: "spawnfile.target-config-resolution.v1" }, terminal_artifact: {
      id: "terminal", max_bytes: 131072, path: "/tmp/spawnfile-public/terminal.json" },
    world_readiness_port: 4070 }, secret_bindings: [{ name: "world_token", scope: "world",
    source_handle: "opaque_cccccccccccccccc" }], version: COMPOSED_EXECUTION_VERSION,
} as const;

test("v2 bootstrap binds execution once without changing authority", () => {
  const initial = createBootstrapComposedPhaseJournal(request, capsule,
    "2026-08-16T00:00:00.000Z");
  let prepared = initial;
  for (const kind of ["resolve_target_config", "select_target",
    "prepare_container_bundle", "provision_credentials"] as const) {
    prepared = journalBootstrapOperationIntent(prepared, kind, { kind });
    const operation = prepared.bootstrap_operations!.at(-1)!;
    prepared = journalBootstrapOperationObservation(
      prepared, operation.operation_id, "completed", { kind },
    );
  }
  const binding = createComposedBootstrapBinding({
    bootstrap_authority_digest: prepared.authority_digest,
    bootstrap_digest: composedBootstrapDigest(capsule),
    execution_digest: digestComposedJson(COMPOSED_EXECUTION_VERSION, execution),
    request_digest: prepared.request_digest, run_id: request.run_id,
    target: { context: "local_test", prepared_evidence_helper: helper,
      selected_target: selected, selected_target_receipt_digest: sha("8"),
      target_config_digest: sha("e") },
  });
  const bound = bindComposedJournalExecution(prepared, execution, binding);
  assert.equal(bound.authority_digest, initial.authority_digest);
  assert.deepEqual(bound.bootstrap_binding, binding);
  assert.throws(() => bindComposedJournalExecution(bound, execution, binding), /binding/u);
});

test("v2 bootstrap operations are ordered, single-flight, and required for binding", () => {
  const initial = createBootstrapComposedPhaseJournal(
    request, capsule, "2026-08-16T00:00:00.000Z",
  );
  assert.throws(() => journalBootstrapOperationIntent(
    initial, "select_target", { kind: "select_target" },
  ), /intent is invalid/u);
  const resolving = journalBootstrapOperationIntent(
    initial, "resolve_target_config", { kind: "resolve_target_config" },
  );
  assert.throws(() => journalBootstrapOperationIntent(
    resolving, "select_target", { kind: "select_target" },
  ), /intent is invalid/u);
  assert.throws(() => bindComposedJournalExecution(initial, execution, {}));
});
