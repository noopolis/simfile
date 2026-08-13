import assert from "node:assert/strict";
import test from "node:test";

import type { ComposedPhaseJournal } from "./journal.js";
import {
  lifecycleDigest,
  lifecyclePhaseContext,
  lifecycleRequest,
  organizationReadyLifecycleJournal,
  tickOneLifecycleJournal,
} from "./lifecycle.test-helper.js";
import {
  createComposedWorldTerminalReceipt,
  superviseComposedWorld,
  type ComposedSupervisionPort,
} from "./supervision.js";

const fakePort = (journal: ComposedPhaseJournal, terminalTick = 4) => {
  const calls = { terminal: 0 };
  const port: ComposedSupervisionPort = {
    waitForWorldTerminal: async ({ running }) => {
      calls.terminal += 1;
      return createComposedWorldTerminalReceipt({
        outcome_digest: lifecycleDigest("0"),
        reason: "completed",
        run_id: journal.request.run_id,
        running_receipt_digest: running.receipt_digest,
        terminal_tick: terminalTick,
      });
    },
  };
  return { calls, port };
};

test("world supervision advances an exact tick horizon without cognition", async () => {
  const initial = tickOneLifecycleJournal();
  const fake = fakePort(initial);
  const journal = await superviseComposedWorld({
    context: lifecyclePhaseContext().context,
    expected_terminal_tick: 4,
    journal: initial,
    port: fake.port,
  });
  assert.equal(journal.current_phase, "terminal");
  assert.deepEqual(fake.calls, { terminal: 1 });
});

test("world supervision resumes both boundaries without waiting twice", async () => {
  for (const failedPhase of ["running", "terminal"] as const) {
    const request = lifecycleRequest({ run_id: `run-${failedPhase}` });
    const initial = tickOneLifecycleJournal(request);
    const fake = fakePort(initial);
    const persisted: ComposedPhaseJournal[] = [];
    await assert.rejects(superviseComposedWorld({
      context: lifecyclePhaseContext({
        afterPhase: (phase) => {
          if (phase === failedPhase) throw new Error(`fault after ${phase}`);
        },
        persisted,
      }).context,
      expected_terminal_tick: 4,
      journal: initial,
      port: fake.port,
    }), /fault after/u);
    const journal = await superviseComposedWorld({
      context: lifecyclePhaseContext().context,
      expected_terminal_tick: 4,
      journal: persisted.at(-1),
      port: fake.port,
    });
    assert.equal(journal.current_phase, "terminal");
    assert.deepEqual(fake.calls, { terminal: 1 });
  }
});

test("world supervision rejects early, stale, cross-run, and forged terminal proofs", async () => {
  const initial = tickOneLifecycleJournal();
  await assert.rejects(superviseComposedWorld({
    context: lifecyclePhaseContext().context,
    expected_terminal_tick: 4,
    journal: organizationReadyLifecycleJournal(),
    port: fakePort(initial).port,
  }), /requires tick 1/u);
  await assert.rejects(superviseComposedWorld({
    context: lifecyclePhaseContext().context,
    expected_terminal_tick: 3,
    journal: initial,
    port: fakePort(initial, 4).port,
  }), /correlation/u);
  const forged: ComposedSupervisionPort = {
    waitForWorldTerminal: async ({ running }) => ({
      ...createComposedWorldTerminalReceipt({
        outcome_digest: lifecycleDigest("0"),
        reason: "completed",
        run_id: "run-foreign",
        running_receipt_digest: running.receipt_digest,
        terminal_tick: 4,
      }),
      receipt_digest: lifecycleDigest("f"),
    }),
  };
  await assert.rejects(superviseComposedWorld({
    context: lifecyclePhaseContext().context,
    expected_terminal_tick: 4,
    journal: initial,
    port: forged,
  }), /digest/u);
});
