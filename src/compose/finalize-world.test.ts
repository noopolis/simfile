import assert from "node:assert/strict";
import test from "node:test";

import {
  ComposedWorldEvidenceError,
  WORLD_EVIDENCE_RECOVERY_INSTRUCTION,
  createComposedWorldEvidenceReceipt,
  createComposedWorldPauseReceipt,
  finalizeComposedWorld,
  type ComposedWorldEvidenceItem,
  type ComposedWorldFinalizationPort,
} from "./finalize-world.js";
import type { ComposedPhaseJournal } from "./journal.js";
import {
  lifecycleDigest,
  lifecycleHandle,
  lifecyclePhaseContext,
  lifecycleRequest,
  terminalLifecycleJournal,
  tickOneLifecycleJournal,
} from "./lifecycle.test-helper.js";

const inventory = (): ComposedWorldEvidenceItem[] => [
  { authority: "actions", bytes: 100, path: "actions/accepted.jsonl", sha256: lifecycleDigest("a") },
  { authority: "checkpoints", bytes: 200, path: "checkpoints/final.json", sha256: lifecycleDigest("b") },
  { authority: "projections", bytes: 300, path: "projections/world.json", sha256: lifecycleDigest("c") },
];

type Failure = "copy" | "missing" | "tamper" | undefined;

const fakePort = (failure?: Failure) => {
  const calls = { cleanup: 0, export: 0, pause: 0 };
  const source = { preserved: true };
  const port: ComposedWorldFinalizationPort = {
    exportWorldEvidence: async ({ pause }) => {
      calls.export += 1;
      if (failure === "copy") throw new Error("private provider copy failure");
      const items = failure === "missing" ? inventory().slice(0, 2) : inventory();
      const receipt = createComposedWorldEvidenceReceipt({
        export_handle: lifecycleHandle("7"),
        inventory: items,
        pause_receipt_digest: pause.receipt_digest,
        run_id: pause.run_id,
        source_service_handle: pause.service_handle,
      });
      return failure === "tamper"
        ? { ...receipt, inventory: [
          { ...receipt.inventory[0]!, sha256: lifecycleDigest("f") },
          ...receipt.inventory.slice(1),
        ] }
        : receipt;
    },
    pauseWorld: async ({ service, terminal }) => {
      calls.pause += 1;
      return createComposedWorldPauseReceipt({
        final_tick: terminal.terminal_tick,
        run_id: terminal.run_id,
        service_handle: service.service_handle,
        terminal_receipt_digest: terminal.receipt_digest,
      });
    },
  };
  return { calls, port, source };
};

test("world finalization pauses, flushes, hashes, and exports before cleanup", async () => {
  const fake = fakePort();
  const journal = await finalizeComposedWorld({
    context: lifecyclePhaseContext().context,
    journal: terminalLifecycleJournal(),
    port: fake.port,
  });
  assert.equal(journal.current_phase, "world_evidence_exported");
  assert.deepEqual(fake.calls, { cleanup: 0, export: 1, pause: 1 });
  assert.equal(fake.source.preserved, true);
});

test("world evidence admits only the root Spawnfile control namespace", () => {
  const fields = {
    export_handle: lifecycleHandle("7"),
    pause_receipt_digest: lifecycleDigest("d"),
    run_id: "run-one",
    source_service_handle: lifecycleHandle("8"),
  };
  const control = {
    authority: "projections" as const,
    bytes: 10,
    path: ".spawnfile/world-service-activated.v1",
    sha256: lifecycleDigest("e"),
  };
  assert.equal(createComposedWorldEvidenceReceipt({
    ...fields, inventory: [...inventory(), control],
  }).inventory.some(({ path }) => path === control.path), true);
  for (const path of [".foreign/item.json", "projections/.hidden.json",
    "nested/.spawnfile/item.json"]) {
    assert.throws(() => createComposedWorldEvidenceReceipt({
      ...fields, inventory: [...inventory(), { ...control, path }],
    }));
  }
});

test("world finalization resumes both boundaries without repeating owner operations", async () => {
  for (const failedPhase of ["world_paused", "world_evidence_exported"] as const) {
    const request = lifecycleRequest({ run_id: `run-${failedPhase}` });
    const initial = terminalLifecycleJournal(request);
    const fake = fakePort();
    const persisted: ComposedPhaseJournal[] = [];
    await assert.rejects(finalizeComposedWorld({
      context: lifecyclePhaseContext({
        afterPhase: (phase) => {
          if (phase === failedPhase) throw new Error(`fault after ${phase}`);
        },
        persisted,
      }).context,
      journal: initial,
      port: fake.port,
    }), /fault after/u);
    const journal = await finalizeComposedWorld({
      context: lifecyclePhaseContext().context,
      journal: persisted.at(-1),
      port: fake.port,
    });
    assert.equal(journal.current_phase, "world_evidence_exported");
    assert.deepEqual(fake.calls, { cleanup: 0, export: 1, pause: 1 });
  }
});

test("copy, tamper, and missing-artifact failures preserve source with exact recovery", async () => {
  for (const failure of ["copy", "tamper", "missing"] as const) {
    const fake = fakePort(failure);
    const persisted: ComposedPhaseJournal[] = [];
    await assert.rejects(finalizeComposedWorld({
      context: lifecyclePhaseContext({ persisted }).context,
      journal: terminalLifecycleJournal(),
      port: fake.port,
    }), (error: Error) => error instanceof ComposedWorldEvidenceError
      && error.recovery_instruction === WORLD_EVIDENCE_RECOVERY_INSTRUCTION
      && error.source_preserved);
    assert.equal(persisted.at(-1)?.current_phase, "world_paused");
    assert.equal(fake.source.preserved, true);
    assert.deepEqual(fake.calls, { cleanup: 0, export: 1, pause: 1 });
  }
});

test("world finalization rejects early and cross-run exports without cleanup", async () => {
  const fake = fakePort();
  await assert.rejects(finalizeComposedWorld({
    context: lifecyclePhaseContext().context,
    journal: tickOneLifecycleJournal(),
    port: fake.port,
  }), /requires terminal/u);
  const crossRun: ComposedWorldFinalizationPort = {
    ...fake.port,
    exportWorldEvidence: async ({ pause }) => createComposedWorldEvidenceReceipt({
      export_handle: lifecycleHandle("7"),
      inventory: inventory(),
      pause_receipt_digest: pause.receipt_digest,
      run_id: "run-foreign",
      source_service_handle: pause.service_handle,
    }),
  };
  await assert.rejects(finalizeComposedWorld({
    context: lifecyclePhaseContext().context,
    journal: terminalLifecycleJournal(),
    port: crossRun,
  }), (error: Error) => error instanceof ComposedWorldEvidenceError
    && error.source_preserved);
  assert.equal(fake.calls.cleanup, 0);
});
