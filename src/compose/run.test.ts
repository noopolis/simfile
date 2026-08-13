import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createComposedTopologyActivationReceipt,
  parseComposedTopologyActivationReceipt,
} from "./activation.js";
import {
  createComposedCleanupOperationReceipt,
  parseComposedCleanupOperationReceipt,
} from "./cleanup.js";
import { digestComposedJson } from "./json.js";
import { readComposedPhaseJournal } from "./journal.js";
import {
  lifecycleDigest,
  lifecycleHandle,
  lifecyclePreparation,
  lifecycleRequest,
} from "./lifecycle.test-helper.js";
import { recoverComposedRun, runDurableComposedRun } from "./recovery.js";
import { createComposedRunHarness, type ComposedHarnessMutation } from "./run.test-helper.js";
import { createComposedWorldTerminalReceipt } from "./supervision.js";
import { COMPOSED_RUN_PHASES, composedRunPhaseIndex } from "./types.js";

const clock = () => {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 1, 1, 0, 0, tick++)).toISOString();
};

test("one dry-run composes every owner with zero participant actions", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "simfile-composed-e2e-"));
  try {
    const request = lifecycleRequest();
    const harness = createComposedRunHarness(request);
    const journalPath = path.join(directory, "journal.json");
    const outcome = await runDurableComposedRun({
      configuration: harness.configuration,
      journal_path: journalPath,
      now: clock(),
      ports: harness.ports,
      request,
    });
    assert.equal(outcome.receipt.status, "completed");
    assert.equal(outcome.journal.current_phase, "completed");
    assert.deepEqual(outcome.journal.entries.map((entry) => entry.phase), COMPOSED_RUN_PHASES);
    assert.equal(outcome.receipt.run_id, request.run_id);
    assert.equal(outcome.receipt.verdict.state, "valid");
    assert.deepEqual(outcome.receipt.cleanup.remaining_owned_resources, []);
    assert.equal(harness.telemetry.participant_actions, 0);
    assert.equal(harness.telemetry.activation_publications, 1);
    assert.deepEqual(harness.telemetry.calls, [
      "target:prepare",
      "world:create", "world:start-paused", "world:ready",
      "organization:start", "organization:ready",
      "topology:attest", "topology:activate", "world:tick-1", "world:terminal",
      "world:pause", "world:export", "organization:export",
      "cleanup:stop_world", "cleanup:detach_organization", "cleanup:down_organization",
      "cleanup:revoke_secret_bindings", "cleanup:cleanup_target_resources",
    ]);
    assert.equal(Object.values(harness.telemetry.effect_counts).every((count) => count === 1), true);
    const callsBeforeReplay = harness.telemetry.calls.length;
    const replay = await recoverComposedRun({
      configuration: harness.configuration,
      expected_authority: {
        authority_digest: outcome.journal.authority_digest,
        run_id: outcome.journal.request.run_id,
      },
      journal_path: journalPath,
      now: clock(),
      ports: harness.ports,
    });
    assert.equal(replay.receipt.status, "completed");
    assert.equal(harness.telemetry.calls.length, callsBeforeReplay);
    assert.deepEqual(await readComposedPhaseJournal(journalPath), replay.journal);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

const staleActivation = (raw: unknown): unknown => {
  const receipt = parseComposedTopologyActivationReceipt(raw);
  const marker = {
    ...receipt.target_activation,
    topology_request_digest: lifecycleDigest("9"),
    version: "spawnfile.world-service-activation.v1" as const,
  };
  const markerBody = {
    bundle_digest: marker.bundle_digest,
    run_id: marker.run_id,
    state: marker.state,
    topology_receipt_digest: marker.topology_receipt_digest,
    topology_request_digest: marker.topology_request_digest,
    version: marker.version,
  };
  const targetBody = {
    activation_digest: digestComposedJson("spawnfile.world-service-activation.v1", markerBody),
    bundle_digest: marker.bundle_digest,
    run_id: marker.run_id,
    state: marker.state,
    topology_receipt_digest: marker.topology_receipt_digest,
    topology_request_digest: marker.topology_request_digest,
    version: "spawnfile.target-topology-activation-receipt.v1" as const,
  };
  return createComposedTopologyActivationReceipt({
    attestation_receipt_digest: receipt.attestation_receipt_digest,
    run_id: receipt.run_id,
    target_activation: {
      ...targetBody,
      receipt_digest: digestComposedJson(
        "spawnfile.target-topology-activation-receipt.v1", targetBody,
      ),
    },
  });
};

const foreignCleanup = (raw: unknown): unknown => {
  const receipt = parseComposedCleanupOperationReceipt(raw);
  const foreign = lifecycleHandle("z");
  return createComposedCleanupOperationReceipt({
    operation: receipt.operation,
    ownership_digest: receipt.ownership_digest,
    released_handles: [foreign],
    remaining_owned_handles: receipt.remaining_owned_handles,
    run_id: receipt.run_id,
    state: "completed",
    target_handles: [...receipt.target_handles, foreign].sort(),
  });
};

test("forgery sweep fails closed before unsafe downstream work", async () => {
  const request = lifecycleRequest();
  const cases: ReadonlyArray<Readonly<{
    current_phase: typeof COMPOSED_RUN_PHASES[number];
    mutation: ComposedHarnessMutation;
    name: string;
  }>> = [
    {
      current_phase: "requested",
      mutation: {
        preparation: () => lifecyclePreparation(lifecycleRequest({ run_id: "run-cross" })),
      },
      name: "cross-run preparation",
    },
    {
      current_phase: "topology_verified",
      mutation: { activation: staleActivation },
      name: "stale activation",
    },
    {
      current_phase: "world_paused",
      mutation: {
        world_evidence: (raw) => ({
          ...(raw as Record<string, unknown>), inventory_digest: lifecycleDigest("f"),
        }),
      },
      name: "tampered world evidence",
    },
    {
      current_phase: "world_evidence_exported",
      mutation: {
        organization_evidence: (raw) => ({
          ...(raw as Record<string, unknown>), token: "must-not-enter-journal",
        }),
      },
      name: "secret-shaped organization evidence",
    },
    {
      current_phase: "organization_evidence_exported",
      mutation: { cleanup: foreignCleanup },
      name: "foreign cleanup receipt",
    },
  ];
  for (const forgery of cases) {
    const directory = await mkdtemp(path.join(tmpdir(), "simfile-composed-forgery-"));
    try {
      const harness = createComposedRunHarness(request, forgery.mutation);
      const outcome = await runDurableComposedRun({
        configuration: harness.configuration,
        journal_path: path.join(directory, "journal.json"),
        now: clock(),
        ports: harness.ports,
        request,
      });
      assert.equal(outcome.receipt.status, "recovery_required", forgery.name);
      assert.equal(outcome.journal.current_phase, forgery.current_phase, forgery.name);
      assert.equal(
        harness.telemetry.cleanup_targets.includes(lifecycleHandle("z")), false, forgery.name,
      );
      if (composedRunPhaseIndex(forgery.current_phase)
        < composedRunPhaseIndex("organization_evidence_exported")) {
        assert.equal(
          harness.telemetry.calls.some((call) => call.startsWith("cleanup:")), false, forgery.name,
        );
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }
});

test("an interrupted world terminal remains recoverable and never reaches export or cleanup", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "simfile-composed-terminal-"));
  try {
    const request = lifecycleRequest({ run_id: "run-terminal-interrupted" });
    const harness = createComposedRunHarness(request, {
      terminal: (raw) => {
        const terminal = raw as Record<string, unknown>;
        const body = {
          outcome_digest: terminal.outcome_digest as string,
          reason: "interrupted" as const,
          run_id: terminal.run_id as string,
          running_receipt_digest: terminal.running_receipt_digest as string,
          terminal_tick: terminal.terminal_tick as number,
        };
        return createComposedWorldTerminalReceipt(body);
      },
    });
    const outcome = await runDurableComposedRun({
      configuration: harness.configuration,
      journal_path: path.join(directory, "journal.json"),
      now: clock(),
      ports: harness.ports,
      request,
    });
    assert.equal(outcome.receipt.status, "recovery_required");
    assert.equal(outcome.journal.current_phase, "running");
    assert.equal(harness.telemetry.calls.some((call) =>
      call.includes("export") || call.startsWith("cleanup:")), false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
