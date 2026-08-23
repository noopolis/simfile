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

const pollingPort = () => {
  const state = { aborts: 0, polls: 0, settled: false };
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const port: ComposedSupervisionPort = {
    waitForWorldTerminal: ({ signal }) => new Promise((_resolve, reject) => {
      markStarted();
      const poll = setInterval(() => { state.polls += 1; }, 1);
      signal.addEventListener("abort", () => {
        state.aborts += 1;
        clearInterval(poll);
        queueMicrotask(() => {
          state.settled = true;
          reject(signal.reason);
        });
      }, { once: true });
    }),
  };
  return { port, started, state };
};

const pause = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

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

test("world supervision timeout aborts and quiesces terminal polling", async () => {
  const polling = pollingPort();
  await assert.rejects(superviseComposedWorld({
    context: lifecyclePhaseContext().context,
    expected_terminal_tick: 4,
    journal: tickOneLifecycleJournal(),
    operator_timeout_ms: 5,
    port: polling.port,
  }), /operator timeout/u);
  assert.equal(polling.state.aborts, 1);
  assert.equal(polling.state.settled, true);
  const pollsAtReturn = polling.state.polls;
  await pause(10);
  assert.equal(polling.state.polls, pollsAtReturn);
});

test("world supervision abort signal quiesces terminal polling before rejection", async () => {
  const polling = pollingPort();
  const controller = new AbortController();
  const supervision = superviseComposedWorld({
    context: lifecyclePhaseContext().context,
    expected_terminal_tick: 4,
    journal: tickOneLifecycleJournal(),
    port: polling.port,
    signal: controller.signal,
  });
  await polling.started;
  controller.abort(new Error("operator interrupted supervision"));
  await assert.rejects(supervision, /operator interrupted supervision/u);
  assert.equal(polling.state.aborts, 1);
  assert.equal(polling.state.settled, true);
  const pollsAtReturn = polling.state.polls;
  await pause(10);
  assert.equal(polling.state.polls, pollsAtReturn);
});

test("world supervision reports an uncooperative port within a second bound", async () => {
  const started = Date.now();
  await assert.rejects(superviseComposedWorld({
    context: lifecyclePhaseContext().context,
    expected_terminal_tick: 4,
    journal: tickOneLifecycleJournal(),
    operator_timeout_ms: 5,
    port: { waitForWorldTerminal: async () => new Promise(() => undefined) },
    quiescence_timeout_ms: 5,
  }), /failed to quiesce/u);
  assert.ok(Date.now() - started < 100, "uncooperative port exceeded its quiescence bound");
});
