import assert from "node:assert/strict";
import test from "node:test";

import type { ComposedPhaseJournal } from "./journal.js";
import {
  lifecycleDigest,
  lifecycleOrganizationExpectation,
  lifecycleOrganizationUpReceipt,
  lifecyclePhaseContext,
  lifecycleRequest,
  preparedLifecycleJournal,
  worldReadyLifecycleJournal,
} from "./lifecycle.test-helper.js";
import {
  startComposedOrganization,
  verifyComposedOrganizationUpReceipt,
  type ComposedOrganizationStartupPort,
} from "./startup-organization.js";

const expectation = lifecycleOrganizationExpectation;
const upReceipt = lifecycleOrganizationUpReceipt;

const fakePort = (runId: string) => {
  const calls = { ready: 0, start: 0 };
  const port: ComposedOrganizationStartupPort = {
    readOrganizationReadiness: async () => { calls.ready += 1; return upReceipt(runId, true); },
    startOrganization: async () => { calls.start += 1; return upReceipt(runId, false); },
  };
  return { calls, port };
};

test("organization starts second and verifies exact binding and pinned Moltnet identity", async () => {
  const request = lifecycleRequest();
  const fake = fakePort(request.run_id);
  const journal = await startComposedOrganization({
    context: lifecyclePhaseContext().context,
    expectation: expectation(),
    journal: worldReadyLifecycleJournal(request),
    port: fake.port,
  });
  assert.equal(journal.current_phase, "organization_ready");
  assert.deepEqual(fake.calls, { ready: 1, start: 1 });
});

test("organization startup resumes each boundary without duplicate starts or probes", async () => {
  for (const failedPhase of ["organization_started", "organization_ready"] as const) {
    const request = lifecycleRequest({ run_id: `run-${failedPhase}` });
    const fake = fakePort(request.run_id);
    const persisted: ComposedPhaseJournal[] = [];
    let injected = false;
    await assert.rejects(startComposedOrganization({
      context: lifecyclePhaseContext({
        afterPhase: (phase) => {
          if (!injected && phase === failedPhase) {
            injected = true;
            throw new Error(`fault after ${phase}`);
          }
        },
        persisted,
      }).context,
      expectation: expectation(),
      journal: worldReadyLifecycleJournal(request),
      port: fake.port,
    }), /fault after/u);
    const resumed = await startComposedOrganization({
      context: lifecyclePhaseContext().context,
      expectation: expectation(),
      journal: persisted.at(-1),
      port: fake.port,
    });
    assert.equal(resumed.current_phase, "organization_ready");
    assert.deepEqual(fake.calls, { ready: 1, start: 1 });
  }
});

test("organization startup rejects ordering, binding, run, release, and cognition criteria", async () => {
  const request = lifecycleRequest();
  const fake = fakePort(request.run_id);
  await assert.rejects(startComposedOrganization({
    context: lifecyclePhaseContext().context,
    expectation: expectation(),
    journal: preparedLifecycleJournal(request),
    port: fake.port,
  }), /requires world readiness/u);
  for (const raw of [
    { ...upReceipt(request.run_id, true), run_id: "run-foreign" },
    {
      ...upReceipt(request.run_id, true),
      organization_ready: {
        ...upReceipt(request.run_id, true).organization_ready,
        world_binding_digest: lifecycleDigest("f"),
      },
    },
    {
      ...upReceipt(request.run_id, true),
      organization_ready: {
        ...upReceipt(request.run_id, true).organization_ready,
        unit_id: "organization-unit",
      },
    },
    { ...upReceipt(request.run_id, true), moltnet_release: undefined },
    {
      ...upReceipt(request.run_id, true),
      moltnet_release: { ...upReceipt(request.run_id, true).moltnet_release, capabilities: [] },
    },
    {
      ...upReceipt(request.run_id, true),
      moltnet_release: { ...upReceipt(request.run_id, true).moltnet_release, release_version: "latest" },
    },
    {
      ...upReceipt(request.run_id, true),
      organization_handoff: {
        ...upReceipt(request.run_id, true).organization_handoff,
        deployment_handle: `sf-oh1-${"0".repeat(64)}`,
      },
    },
    { ...upReceipt(request.run_id, true), agent_response_count: 2 },
  ]) assert.throws(() => verifyComposedOrganizationUpReceipt({
    expectation: expectation(), raw, require_ready: true, run_id: request.run_id,
  }), /correlation|readiness|agent-response|invalid|expected/u);
});
