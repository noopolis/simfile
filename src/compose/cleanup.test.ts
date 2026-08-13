import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupComposedRun,
  ComposedCleanupError,
  createComposedCleanupOperationReceipt,
  parseComposedCleanupReceipt,
  type ComposedCleanupOperation,
  type ComposedCleanupPort,
} from "./cleanup.js";
import { finalizeComposedOrganization } from "./finalize-organization.js";
import {
  createComposedWorldEvidenceReceipt,
  createComposedWorldPauseReceipt,
} from "./finalize-world.js";
import { appendComposedPhase, type ComposedPhaseJournal } from "./journal.js";
import {
  lifecycleDigest,
  lifecycleHandle,
  lifecyclePhaseContext,
  lifecycleRequest,
  terminalLifecycleJournal,
  worldEvidenceLifecycleJournal,
} from "./lifecycle.test-helper.js";
import { composedPhasePayload } from "./phase.js";
import { parseComposedWorldServiceReceipt } from "./startup-world.js";
import { parseComposedWorldTerminalReceipt } from "./supervision.js";

const organizationExport = (runId: string) => ({
  deployment: "organization-unit",
  failed_files: [],
  index: {
    deployment: "organization-unit",
    exported_at: "2026-01-01T00:00:14.000Z",
    files: [
      { bytes: 1, path: "raw/daimon/member/log.jsonl", sha256: "a".repeat(64), source: { kind: "volume", ref: "d:/log" } },
      { bytes: 1, path: "raw/mneme/bank/log.jsonl", sha256: "b".repeat(64), source: { kind: "volume", ref: "m:/log" } },
      { bytes: 1, path: "raw/moltnet/log.jsonl", sha256: "c".repeat(64), source: { kind: "volume", ref: "n:/log" } },
    ],
    run_id: runId,
    version: "spawnfile.export-index.v1",
  },
  index_path: "/evidence/spawnfile/export-index.json",
  missing_optional_files: [],
});

const evidenceCompleteJournal = async (request = lifecycleRequest()) =>
  finalizeComposedOrganization({
    context: lifecyclePhaseContext().context,
    deployment_name: "organization-unit",
    journal: worldEvidenceLifecycleJournal(request),
    port: { exportOrganizationEvidence: async () => organizationExport(request.run_id) },
  });

const fakePort = (input: Readonly<{
  foreignAt?: ComposedCleanupOperation;
  partialAt?: ComposedCleanupOperation;
}> = {}) => {
  const calls: Array<{
    operation: ComposedCleanupOperation;
    owned_handles: readonly string[];
    target_handles: readonly string[];
  }> = [];
  const sideEffects = new Set<string>();
  const port: ComposedCleanupPort = {
    performCleanupOperation: async (request) => {
      calls.push({
        operation: request.operation,
        owned_handles: request.owned_handles,
        target_handles: request.target_handles,
      });
      sideEffects.add(request.idempotency_key);
      if (input.foreignAt === request.operation) {
        const foreign = lifecycleHandle("z");
        return createComposedCleanupOperationReceipt({
          operation: request.operation,
          ownership_digest: request.ownership_digest,
          released_handles: [foreign],
          remaining_owned_handles: [...request.owned_handles],
          run_id: request.run_id,
          state: "completed",
          target_handles: [...request.target_handles, foreign].sort(),
        });
      }
      const releasable = request.operation === "stop_world" ? [] : [...request.target_handles];
      const released = input.partialAt === request.operation ? releasable.slice(0, 1) : releasable;
      const remaining = request.owned_handles.filter((handle) => !released.includes(handle));
      return createComposedCleanupOperationReceipt({
        operation: request.operation,
        ownership_digest: request.ownership_digest,
        released_handles: [...released].sort(),
        remaining_owned_handles: [...remaining].sort(),
        run_id: request.run_id,
        state: input.partialAt === request.operation ? "incomplete" : "completed",
        target_handles: [...request.target_handles].sort(),
      });
    },
  };
  return { calls, port, sideEffects };
};

test("cleanup targets only receipt-owned handles and leaks nothing", async () => {
  const fake = fakePort();
  const journal = await cleanupComposedRun({
    context: lifecyclePhaseContext().context,
    journal: await evidenceCompleteJournal(),
    port: fake.port,
  });
  const receipt = parseComposedCleanupReceipt(composedPhasePayload(journal, "cleaned").receipt);
  assert.equal(journal.current_phase, "cleaned");
  assert.deepEqual(receipt.remaining_owned_resources, []);
  assert.deepEqual(fake.calls.map((call) => call.operation), [
    "stop_world", "detach_organization", "down_organization",
    "revoke_secret_bindings", "cleanup_target_resources",
  ]);
  for (const call of fake.calls) {
    assert.equal(call.target_handles.every((handle) => call.owned_handles.includes(handle)), true);
  }
  const replayed = await cleanupComposedRun({
    context: lifecyclePhaseContext().context,
    journal,
    port: fake.port,
  });
  assert.equal(replayed.current_phase, "cleaned");
  assert.equal(fake.calls.length, 5);
});

test("cleanup resumes after its durable boundary without repeated side effects", async () => {
  const initial = await evidenceCompleteJournal();
  const fake = fakePort();
  const persisted: ComposedPhaseJournal[] = [];
  await assert.rejects(cleanupComposedRun({
    context: lifecyclePhaseContext({
      afterPhase: (phase) => {
        if (phase === "cleaned") throw new Error("fault after cleaned");
      },
      persisted,
    }).context,
    journal: initial,
    port: fake.port,
  }), /fault after cleaned/u);
  const resumed = await cleanupComposedRun({
    context: lifecyclePhaseContext().context,
    journal: persisted.at(-1),
    port: fake.port,
  });
  assert.equal(resumed.current_phase, "cleaned");
  assert.equal(fake.calls.length, 5);
  assert.equal(fake.sideEffects.size, 5);
});

test("cleanup refuses unexported or forged evidence before any owner operation", async () => {
  const fake = fakePort();
  await assert.rejects(cleanupComposedRun({
    context: lifecyclePhaseContext().context,
    journal: terminalLifecycleJournal(),
    port: fake.port,
  }), /requires both evidence exports/u);
  const request = lifecycleRequest();
  const forged = appendComposedPhase(worldEvidenceLifecycleJournal(request),
    "organization_evidence_exported", {
      evidence: { state: "exported" },
      receipt_digest: lifecycleDigest("f"),
      run_id: request.run_id,
    }, "2026-01-01T00:00:14.000Z");
  await assert.rejects(cleanupComposedRun({
    context: lifecyclePhaseContext().context,
    journal: forged,
    port: fake.port,
  }));
  assert.equal(fake.calls.length, 0);
});

test("rehash-valid foreign world or organization evidence cannot reach cleanup", async () => {
  const request = lifecycleRequest();
  const targetTerminal = terminalLifecycleJournal(request);
  const service = parseComposedWorldServiceReceipt(
    composedPhasePayload(targetTerminal, "world_started_paused").receipt,
  );
  const terminal = parseComposedWorldTerminalReceipt(
    composedPhasePayload(targetTerminal, "terminal").receipt,
  );
  const pause = createComposedWorldPauseReceipt({
    final_tick: terminal.terminal_tick,
    run_id: request.run_id,
    service_handle: service.service_handle,
    terminal_receipt_digest: terminal.receipt_digest,
  });
  const paused = appendComposedPhase(targetTerminal, "world_paused", {
    receipt: pause, receipt_digest: pause.receipt_digest, run_id: request.run_id,
  }, "2026-01-01T00:00:12.000Z");
  const foreignWorld = createComposedWorldEvidenceReceipt({
    export_handle: lifecycleHandle("7"),
    inventory: [
      { authority: "actions", bytes: 1, path: "actions/log.jsonl", sha256: lifecycleDigest("a") },
      { authority: "checkpoints", bytes: 2, path: "checkpoints/final.json", sha256: lifecycleDigest("b") },
      { authority: "projections", bytes: 3, path: "projections/world.json", sha256: lifecycleDigest("c") },
    ],
    pause_receipt_digest: pause.receipt_digest,
    run_id: "run-foreign",
    source_service_handle: service.service_handle,
  });
  const substitutedWorld = appendComposedPhase(paused, "world_evidence_exported", {
    evidence: foreignWorld,
    receipt_digest: foreignWorld.receipt_digest,
    run_id: request.run_id,
  }, "2026-01-01T00:00:13.000Z");
  const worldComplete = await finalizeComposedOrganization({
    context: lifecyclePhaseContext().context,
    deployment_name: "organization-unit",
    journal: substitutedWorld,
    port: { exportOrganizationEvidence: async () => organizationExport(request.run_id) },
  });

  const foreignRequest = lifecycleRequest({ run_id: "run-foreign" });
  const foreignComplete = await evidenceCompleteJournal(foreignRequest);
  const foreignOrganizationPayload = composedPhasePayload(
    foreignComplete, "organization_evidence_exported",
  );
  const substitutedOrganization = appendComposedPhase(
    worldEvidenceLifecycleJournal(request),
    "organization_evidence_exported",
    { ...foreignOrganizationPayload, run_id: request.run_id },
    "2026-01-01T00:00:14.000Z",
  );

  for (const journal of [worldComplete, substitutedOrganization]) {
    const isolated = fakePort();
    await assert.rejects(cleanupComposedRun({
      context: lifecyclePhaseContext().context,
      journal,
      port: isolated.port,
    }), /evidence correlation/u);
    assert.equal(isolated.calls.length, 0);
  }
});

test("foreign receipts fail closed and partial cleanup reports exact remaining ownership", async () => {
  const initial = await evidenceCompleteJournal();
  const foreign = fakePort({ foreignAt: "detach_organization" });
  await assert.rejects(cleanupComposedRun({
    context: lifecyclePhaseContext().context,
    journal: initial,
    port: foreign.port,
  }), (error: Error) => error instanceof ComposedCleanupError
    && error.failed_operation === "detach_organization");
  assert.equal(foreign.calls.some((call) => call.target_handles.includes(lifecycleHandle("z"))), false);

  const partial = fakePort({ partialAt: "cleanup_target_resources" });
  await assert.rejects(cleanupComposedRun({
    context: lifecyclePhaseContext().context,
    journal: initial,
    port: partial.port,
  }), (error: Error) => error instanceof ComposedCleanupError
    && error.failed_operation === "cleanup_target_resources"
    && error.remaining_owned_resources.length === 3);
});
