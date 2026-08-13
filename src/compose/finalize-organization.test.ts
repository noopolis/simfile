import assert from "node:assert/strict";
import test from "node:test";

import {
  composedOrganizationExportLifecycleInvocationId,
  ComposedOrganizationEvidenceError,
  ORGANIZATION_EVIDENCE_RECOVERY_INSTRUCTION,
  finalizeComposedOrganization,
  parseComposedOrganizationEvidenceReceipt,
  type ComposedOrganizationFinalizationPort,
} from "./finalize-organization.js";
import { createComposedRunRequestDigest } from "./request.js";
import type { ComposedPhaseJournal } from "./journal.js";
import {
  lifecyclePhaseContext,
  lifecycleRequest,
  terminalLifecycleJournal,
  worldEvidenceLifecycleJournal,
} from "./lifecycle.test-helper.js";
import { composedPhasePayload } from "./phase.js";

const exportResult = (runId: string) => ({
  deployment: "organization-unit",
  failed_files: [],
  index: {
    deployment: "organization-unit",
    exported_at: "2026-01-01T00:00:14.000Z",
    files: [
      {
        bytes: 10,
        path: "raw/daimon/member/causal.jsonl",
        sha256: "a".repeat(64),
        source: { kind: "volume", ref: "daimon-volume:/causal.jsonl" },
      },
      {
        bytes: 20,
        path: "raw/mneme/bank/events.jsonl",
        sha256: "b".repeat(64),
        source: { kind: "volume", ref: "mneme-volume:/events.jsonl" },
      },
      {
        bytes: 30,
        path: "raw/moltnet/causal.jsonl",
        sha256: "c".repeat(64),
        source: { kind: "volume", ref: "moltnet-volume:/causal.jsonl" },
      },
    ],
    run_id: runId,
    version: "spawnfile.export-index.v1",
  },
  index_path: "/run/evidence/spawnfile/export-index.json",
  missing_optional_files: [],
});

const fakePort = (
  runId: string,
  mutate: (value: ReturnType<typeof exportResult>) => unknown = (value) => value,
) => {
  const calls = { down: 0, requests: 0, side_effects: 0 };
  const cache = new Map<string, unknown>();
  const source = { preserved: true };
  const port: ComposedOrganizationFinalizationPort = {
    exportOrganizationEvidence: async ({ lifecycle_invocation_id }) => {
      calls.requests += 1;
      if (!cache.has(lifecycle_invocation_id)) {
        calls.side_effects += 1;
        cache.set(lifecycle_invocation_id, mutate(exportResult(runId)));
      }
      return cache.get(lifecycle_invocation_id);
    },
  };
  return { calls, port, source };
};

test("organization export lifecycle identity is request-bound", () => {
  const digest = createComposedRunRequestDigest(lifecycleRequest());
  const invocation = composedOrganizationExportLifecycleInvocationId(digest);
  assert.match(invocation, /^lci_[a-f0-9]{32}$/u);
  assert.equal(invocation, composedOrganizationExportLifecycleInvocationId(digest));
  assert.throws(() => composedOrganizationExportLifecycleInvocationId("sha256:invalid"));
});

test("organization export reconciles all four evidence authorities before down", async () => {
  const request = lifecycleRequest();
  const fake = fakePort(request.run_id);
  const journal = await finalizeComposedOrganization({
    context: lifecyclePhaseContext().context,
    deployment_name: "organization-unit",
    journal: worldEvidenceLifecycleJournal(request),
    port: fake.port,
  });
  const evidence = parseComposedOrganizationEvidenceReceipt(
    composedPhasePayload(journal, "organization_evidence_exported").evidence,
  );
  assert.equal(journal.current_phase, "organization_evidence_exported");
  assert.deepEqual(evidence.authorities.map((item) => item.authority), [
    "spawnfile", "moltnet", "daimon", "mneme",
  ]);
  assert.deepEqual(fake.calls, { down: 0, requests: 1, side_effects: 1 });
});

test("organization export admits an empty Mneme authority when no memory bank was planned", async () => {
  const request = lifecycleRequest();
  const fake = fakePort(request.run_id, (value) => ({
    ...value,
    index: {
      ...value.index,
      files: value.index.files.filter((item) => !item.path.startsWith("raw/mneme/")),
    },
  }));
  const journal = await finalizeComposedOrganization({
    context: lifecyclePhaseContext().context,
    deployment_name: "organization-unit",
    journal: worldEvidenceLifecycleJournal(request),
    port: fake.port,
  });
  const evidence = parseComposedOrganizationEvidenceReceipt(
    composedPhasePayload(journal, "organization_evidence_exported").evidence,
  );
  const mneme = evidence.authorities.find((item) => item.authority === "mneme");
  assert.ok(mneme);
  assert.equal(mneme.item_count, 0);
  assert.equal(mneme.missing_optional_count, 0);
  assert.deepEqual(fake.calls, { down: 0, requests: 1, side_effects: 1 });
});

test("organization export is exact-idempotent across pre-persist failure and phase replay", async () => {
  const request = lifecycleRequest();
  const initial = worldEvidenceLifecycleJournal(request);
  const fake = fakePort(request.run_id);
  await assert.rejects(finalizeComposedOrganization({
    context: {
      now: () => "2026-01-01T00:00:14.000Z",
      persist: () => { throw new Error("persistence unavailable"); },
    },
    deployment_name: "organization-unit",
    journal: initial,
    port: fake.port,
  }), /persistence unavailable/u);
  const journal = await finalizeComposedOrganization({
    context: lifecyclePhaseContext().context,
    deployment_name: "organization-unit",
    journal: initial,
    port: fake.port,
  });
  const replayed = await finalizeComposedOrganization({
    context: lifecyclePhaseContext().context,
    deployment_name: "organization-unit",
    journal,
    port: fake.port,
  });
  assert.equal(replayed.current_phase, "organization_evidence_exported");
  assert.deepEqual(fake.calls, { down: 0, requests: 2, side_effects: 1 });
});

test("missing, divergent, failed, and cross-run exports block down and remain recoverable", async () => {
  const request = lifecycleRequest();
  const cases = [
    (value: ReturnType<typeof exportResult>) => ({
      ...value,
      index: { ...value.index, files: value.index.files.filter(
        (item) => !item.path.startsWith("raw/moltnet/"),
      ) },
    }),
    (value: ReturnType<typeof exportResult>) => ({
      ...value,
      index: { ...value.index, files: value.index.files.filter(
        (item) => !item.path.startsWith("raw/daimon/"),
      ) },
    }),
    (value: ReturnType<typeof exportResult>) => ({ ...value, deployment: "other-unit" }),
    (value: ReturnType<typeof exportResult>) => ({
      ...value, failed_files: ["raw/moltnet/causal.jsonl"],
    }),
    (value: ReturnType<typeof exportResult>) => ({
      ...value, index: { ...value.index, run_id: "run-foreign" },
    }),
  ];
  for (const mutate of cases) {
    const fake = fakePort(request.run_id, mutate);
    await assert.rejects(finalizeComposedOrganization({
      context: lifecyclePhaseContext().context,
      deployment_name: "organization-unit",
      journal: worldEvidenceLifecycleJournal(request),
      port: fake.port,
    }), (error: Error) => error instanceof ComposedOrganizationEvidenceError
      && error.recovery_instruction === ORGANIZATION_EVIDENCE_RECOVERY_INSTRUCTION
      && error.source_preserved);
    assert.deepEqual(fake.calls, { down: 0, requests: 1, side_effects: 1 });
    assert.equal(fake.source.preserved, true);
  }
});

test("organization export refuses to run before world evidence exists", async () => {
  const request = lifecycleRequest();
  const fake = fakePort(request.run_id);
  await assert.rejects(finalizeComposedOrganization({
    context: lifecyclePhaseContext().context,
    deployment_name: "organization-unit",
    journal: terminalLifecycleJournal(request),
    port: fake.port,
  }), /requires world evidence/u);
  assert.deepEqual(fake.calls, { down: 0, requests: 0, side_effects: 0 });
});
