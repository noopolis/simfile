import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendComposedPhase,
  createComposedPhaseJournal,
  markComposedJournalRecoverable,
  parseComposedPhaseJournal,
  readComposedPhaseJournal,
  writeComposedPhaseJournal,
} from "./journal.js";
import { composedRecoveryCommand } from "./receipt.js";
import { COMPOSED_RUN_PHASES } from "./types.js";

const sha = (value: string): `sha256:${string}` =>
  `sha256:${value.repeat(64).slice(0, 64)}`;
const request = {
  descriptor_digest: sha("a"),
  mode: "dry-run",
  organization: {
    artifact_digest: sha("b"), source_digest: sha("c"), world_bindings_digest: sha("d"),
  },
  required_world_capabilities: [],
  run_id: "run-one",
  source_digest: sha("e"),
  target: { auth_profile: "test-auth-profile", selector: "local-test-target" },
  version: "simfile.composed-run-request.v1",
  world: {
    artifact_manifest_digest: sha("f"), bundle_digest: sha("1"),
    runtime_abi: "simfile.world-sidecar-runtime.v1",
  },
} as const;
const at = (index: number): string => `2026-08-07T00:00:${String(index).padStart(2, "0")}.000Z`;
const proof = (phase: string) => ({ proof_digest: sha(phase.charAt(0) || "a"), run_id: "run-one" });
const execution = {
  configuration: {
    organization_expectation: {
      deployment_name: "organization_unit",
      member_engines: { member: "engine-v1" },
      moltnet_release: {
        architecture: "amd64",
        asset_sha256: sha("2"),
        release_version: "v1.2.3",
        source_revision: "3".repeat(40),
      },
      selected_target_receipt_digest: sha("4"),
      unit_id: "organization_unit_container",
      world_binding_digest: request.organization.world_bindings_digest,
    },
    readiness_expectation: {
      artifact_digest: sha("5"),
      bundle_digest: request.world.bundle_digest,
      capability_manifest_digests: [sha("6")],
      mechanics_sha256: sha("7"),
      normalized_checkpoint_sha256: sha("8"),
      run_id: request.run_id,
      world_instance_id: "run-one-world",
    },
    terminal_tick: 4,
    topology_expectation: {
      selected_target: { fingerprint: `sha256:${"9".repeat(32)}`, handle: "opaque_aaaaaaaaaaaaaaaa" },
    },
  },
  provider: {
    compiled_output_directory: "/tmp/spawnfile-compiled",
    evidence_destination_directory: "/tmp/spawnfile-evidence",
    evidence_mount_path: "/var/lib/simfile/evidence",
    lifecycle_invocations: {
      down: "lci_down_aaaaaaaaaaaa",
      export: "lci_export_aaaaaaaaaa",
      up: "lci_up_aaaaaaaaaaaaaa",
    },
    organization_handoff: {
      env_file: "/tmp/runtime.env",
      selected_target_receipt_file: "/tmp/selected-target.json",
      world_bindings_file: "/tmp/world-bindings.json",
    },
    organization_container_name: "organization_unit",
    organization_image_tag: "organization-unit:run-one",
    organization_path: "/tmp/organization.yaml",
    spawnfile_bin: "/tmp/spawnfile/dist/cli/index.js",
    spawnfile_cwd: "/tmp/spawnfile",
    spawnfile_executable_sha256: sha("1"),
    terminal_artifact: {
      id: "terminal_receipt",
      max_bytes: 131_072,
      path: "/tmp/spawnfile-public/terminal.json",
    },
    world_readiness_port: 8080,
  },
  secret_bindings: [{ name: "provider_key", scope: "world", source_handle: "opaque_bbbbbbbbbbbbbbbb" }],
  version: "simfile.composed-execution.v1",
} as const;

test("phase journal advances monotonically, replays exactly, and restores byte truth", async () => {
  let journal = createComposedPhaseJournal(request, at(0));
  const authority = journal.authority_digest;
  const genesis = journal.genesis_nonce;
  const prepared = proof("prepared");
  journal = appendComposedPhase(journal, "prepared", prepared, at(1));
  assert.equal(journal.authority_digest, authority);
  assert.equal(journal.genesis_nonce, genesis);
  assert.deepEqual(appendComposedPhase(journal, "prepared", prepared, at(2)), journal);
  assert.throws(() => appendComposedPhase(journal, "prepared", {
    ...prepared, proof_digest: sha("9"),
  }, at(2)), /contradictory/u);
  assert.throws(() => appendComposedPhase(journal, "world_started_paused", proof("world"), at(2)), /monotonic/u);

  const root = await mkdtemp(path.join(os.tmpdir(), "simfile-compose-journal-"));
  try {
    const file = path.join(root, "journal.json");
    await writeComposedPhaseJournal(file, journal);
    assert.deepEqual(await readComposedPhaseJournal(file), journal);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("journal reaches complete only through every exact phase", () => {
  let journal = createComposedPhaseJournal(request, at(0));
  for (let index = 1; index < COMPOSED_RUN_PHASES.length; index += 1) {
    const phase = COMPOSED_RUN_PHASES[index]!;
    journal = appendComposedPhase(journal, phase, proof(phase), at(index));
  }
  assert.equal(journal.current_phase, "completed");
  assert.equal(journal.state, "complete");
  assert.equal(journal.entries.length, COMPOSED_RUN_PHASES.length);
});

test("recovery state binds the exact next phase and command", () => {
  const journal = appendComposedPhase(
    createComposedPhaseJournal(request, at(0)),
    "prepared",
    proof("prepared"),
    at(1),
  );
  const recovery = markComposedJournalRecoverable(journal, {
    recovery_command: composedRecoveryCommand(
      "/tmp/run-one/journal.json", journal.request.run_id, journal.authority_digest,
    ),
    signal: "SIGTERM",
  });
  assert.equal(recovery.state, "recoverable");
  assert.equal(recovery.authority_digest, journal.authority_digest);
  assert.equal(recovery.genesis_nonce, journal.genesis_nonce);
  assert.equal(recovery.interruption?.next_phase, "world_created");
  assert.deepEqual(parseComposedPhaseJournal(recovery), recovery);
});

test("journal fails closed on stale, cross-run, tampered, contradictory, or secret-shaped data", () => {
  const journal = appendComposedPhase(
    createComposedPhaseJournal(request, at(0)),
    "prepared",
    proof("prepared"),
    at(1),
  );
  assert.throws(() => appendComposedPhase(journal, "world_created", {
    proof_digest: sha("2"), run_id: "run-foreign",
  }, at(2)), /run correlation/u);
  assert.throws(() => appendComposedPhase(journal, "world_created", {
    proof_digest: sha("2"), run_id: "run-one", detail: "token=private-value",
  }, at(2)), /secret-shaped/u);
  assert.throws(() => parseComposedPhaseJournal({ ...journal, journal_digest: sha("0") }), /digest/u);
  assert.throws(() => parseComposedPhaseJournal({
    ...journal,
    state: "recoverable",
    interruption: null,
  }), /contradictory/u);
});

test("journal durably binds only nonsecret execution inputs for exact restart", () => {
  const journal = createComposedPhaseJournal(request, at(0), execution);
  assert.deepEqual(journal.execution, execution);
  assert.doesNotMatch(JSON.stringify(journal), /token=|Bearer |private_config/u);
  assert.throws(() => createComposedPhaseJournal(request, at(0), {
    ...execution,
    provider: {
      ...execution.provider,
      spawnfile_bin: "token=must-not-persist",
    },
  }), /secret-shaped/u);
});
