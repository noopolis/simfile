import assert from "node:assert/strict";
import test from "node:test";

import {
  lifecycleHandle,
  lifecyclePhaseContext,
  lifecyclePreparation,
  lifecycleReadiness,
  lifecycleReadinessExpectation,
  lifecycleRequest,
  preparedLifecycleJournal,
} from "./lifecycle.test-helper.js";
import {
  createComposedWorldResourceReceipt,
  createComposedWorldServiceReceipt,
  startComposedWorld,
  type ComposedWorldStartupPort,
} from "./startup-world.js";
import type { ComposedRunPhase } from "./types.js";
import type { ComposedPhaseJournal } from "./journal.js";

const fakePort = (request = lifecycleRequest()) => {
  const calls = { create: 0, organization: 0, readiness: 0, release: 0, start: 0 };
  const preparation = lifecyclePreparation(request);
  const resource = createComposedWorldResourceReceipt({
    artifact_digest: request.world.artifact_manifest_digest,
    bundle_digest: request.world.bundle_digest,
    preparation_receipt_digest: preparation.receipt_digest,
    resource_handle: lifecycleHandle("2"),
    run_id: request.run_id,
  });
  const service = createComposedWorldServiceReceipt({
    resource_handle: resource.resource_handle,
    run_id: request.run_id,
    service_handle: lifecycleHandle("3"),
  });
  const port: ComposedWorldStartupPort = {
    createWorldResource: async () => { calls.create += 1; return resource; },
    readWorldReadiness: async () => { calls.readiness += 1; return lifecycleReadiness(request); },
    startWorldPaused: async () => { calls.start += 1; return service; },
  };
  return { calls, port, preparation };
};

test("world starts paused and proves pristine readiness with organization absent", async () => {
  const request = lifecycleRequest();
  const fake = fakePort(request);
  const harness = lifecyclePhaseContext();
  const journal = await startComposedWorld({
    context: harness.context,
    journal: preparedLifecycleJournal(request),
    port: fake.port,
    preparation: fake.preparation,
    readiness_expectation: lifecycleReadinessExpectation(request),
  });
  assert.equal(journal.current_phase, "world_ready");
  assert.deepEqual(fake.calls, {
    create: 1, organization: 0, readiness: 1, release: 0, start: 1,
  });
  assert.equal(lifecycleReadiness(request).clock.next_tick, 0);
  assert.throws(() => {
    if (fake.calls.release === 0) throw new Error("world clock is not activated");
  }, /not activated/u);
});

test("every world startup boundary resumes without repeating completed operations", async () => {
  for (const failedPhase of [
    "world_created", "world_started_paused", "world_ready",
  ] as const satisfies readonly ComposedRunPhase[]) {
    const request = lifecycleRequest({ run_id: `run-${failedPhase}` });
    const fake = fakePort(request);
    const persisted: ComposedPhaseJournal[] = [];
    let failed = false;
    const first = lifecyclePhaseContext({
      afterPhase: (phase) => {
        if (!failed && phase === failedPhase) {
          failed = true;
          throw new Error(`fault after ${phase}`);
        }
      },
      persisted,
    });
    await assert.rejects(startComposedWorld({
      context: first.context,
      journal: preparedLifecycleJournal(request),
      port: fake.port,
      preparation: fake.preparation,
      readiness_expectation: lifecycleReadinessExpectation(request),
    }), /fault after/u);
    const durable = persisted.at(-1)!;
    const resumed = await startComposedWorld({
      context: lifecyclePhaseContext().context,
      journal: durable,
      port: fake.port,
      preparation: fake.preparation,
      readiness_expectation: lifecycleReadinessExpectation(request),
    });
    assert.equal(resumed.current_phase, "world_ready");
    assert.deepEqual(fake.calls, {
      create: 1, organization: 0, readiness: 1, release: 0, start: 1,
    }, failedPhase);
  }
});

test("world startup rejects forged preparation and non-pristine readiness", async () => {
  const request = lifecycleRequest();
  const fake = fakePort(request);
  await assert.rejects(startComposedWorld({
    context: lifecyclePhaseContext().context,
    journal: preparedLifecycleJournal(request),
    port: fake.port,
    preparation: { ...fake.preparation, run_id: "run-foreign" },
    readiness_expectation: lifecycleReadinessExpectation(request),
  }), /preparation correlation/u);
  const badPort: ComposedWorldStartupPort = {
    ...fake.port,
    readWorldReadiness: async () => ({
      ...lifecycleReadiness(request),
      clock: { next_tick: 1, state: "running" },
    }),
  };
  await assert.rejects(startComposedWorld({
    context: lifecyclePhaseContext().context,
    journal: preparedLifecycleJournal(request),
    port: badPort,
    preparation: fake.preparation,
    readiness_expectation: lifecycleReadinessExpectation(request),
  }), /paused and pristine/u);
});
