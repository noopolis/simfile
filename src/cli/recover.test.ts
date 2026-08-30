import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createComposedPhaseJournal, writeComposedPhaseJournal } from "../compose/journal.js";
import { lifecycleRequest } from "../compose/lifecycle.test-helper.js";
import { runRecoverCli } from "./recover.js";

test("recover rejects legacy journals without reconstructing a target provider", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simfile-recover-provider-"));
  try {
    const request = lifecycleRequest();
    const journalPath = path.join(root, "journal.json");
    const journal = createComposedPhaseJournal(request, "2026-08-15T00:00:00.000Z", {
      configuration: {
        organization_expectation: {
          deployment_name: "organization-unit", member_engines: {},
          moltnet_release: { architecture: "amd64", asset_sha256: `sha256:${"1".repeat(64)}`,
            release_version: "v1", source_revision: "a".repeat(40) },
          selected_target_receipt_digest: `sha256:${"2".repeat(64)}`,
          unit_id: "organization-unit-container", world_binding_digest: request.organization.world_bindings_digest,
        },
        readiness_expectation: { artifact_digest: null, bundle_digest: request.world.bundle_digest,
          capability_manifest_digests: [`sha256:${"3".repeat(64)}`], mechanics_sha256: `sha256:${"4".repeat(64)}`,
          normalized_checkpoint_sha256: `sha256:${"5".repeat(64)}`, run_id: request.run_id, world_instance_id: "world" },
        terminal_tick: 1,
        topology_expectation: { selected_target: { fingerprint: `sha256:${"6".repeat(32)}`, handle: `opaque_${"7".repeat(16)}` } },
      },
      provider: {
        compiled_output_directory: path.join(root, "compiled"), evidence_destination_directory: path.join(root, "evidence"),
        evidence_mount_path: "/var/lib/simfile/evidence", lifecycle_invocations: { down: `lci_${"a".repeat(16)}`, export: `lci_${"b".repeat(16)}`, up: `lci_${"c".repeat(16)}` },
        organization_handoff: { env_file: path.join(root, "env"), selected_target_receipt_file: path.join(root, "target"), world_bindings_file: path.join(root, "bindings") },
        organization_container_name: "organization-unit", organization_image_tag: "organization-unit:run",
        organization_path: path.join(root, "Spawnfile"), spawnfile_bin: process.execPath, spawnfile_cwd: root,
        spawnfile_executable_sha256: `sha256:${"8".repeat(64)}`,
        terminal_artifact: { id: "terminal", max_bytes: 1024, path: "/tmp/spawnfile-public/terminal.json" }, world_readiness_port: 8080,
      },
      secret_bindings: [{ name: "world_key", scope: "world", source_handle: `opaque_${"9".repeat(16)}` }],
      version: "simfile.composed-execution.v1",
    });
    await writeComposedPhaseJournal(journalPath, journal);
    const before = await readFile(journalPath, "utf8");
    await assert.rejects(runRecoverCli([
      "--journal", journalPath, "--run-id", request.run_id,
      "--authority-digest", journal.authority_digest,
    ]), /legacy composed journal lacks the public target bootstrap capsule/u);
    assert.equal(await readFile(journalPath, "utf8"), before);
    const stored = JSON.parse(await readFile(journalPath, "utf8")) as {
      current_phase: string; state: string;
    };
    assert.equal(stored.current_phase, "requested");
    assert.equal(stored.state, "active");
  } finally { await rm(root, { force: true, recursive: true }); }
});
