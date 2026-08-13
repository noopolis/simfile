import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createComposedWorldTerminalReceipt,
  superviseComposedWorld } from "./supervision.js";
import { lifecyclePhaseContext, tickOneLifecycleJournal } from "./lifecycle.test-helper.js";

const atTickOne = () => {
  const persisted: ReturnType<typeof tickOneLifecycleJournal>[] = [];
  return { ...lifecyclePhaseContext({ persisted }), journal: tickOneLifecycleJournal() };
};

describe("service-only composed supervision", () => {
  it("accepts world terminal truth without consulting behavior", async () => {
    const { context, journal } = atTickOne();
    let receivedSignal: AbortSignal | undefined;
    const result = await superviseComposedWorld({
      context, expected_terminal_tick: 40, journal, operator_timeout_ms: 1_000,
      port: { waitForWorldTerminal: async ({ running, signal }) => {
        receivedSignal = signal;
        return createComposedWorldTerminalReceipt({
          outcome_digest: `sha256:${"a".repeat(64)}`, reason: "completed",
          run_id: running.run_id, running_receipt_digest: running.receipt_digest,
          terminal_tick: 40,
        });
      } },
    });
    assert.equal(result.current_phase, "terminal");
    assert.equal(receivedSignal?.aborted, false);
  });

  it("fails on operator timeout without turning it into world truth", async () => {
    const { context, journal, persisted } = atTickOne();
    await assert.rejects(superviseComposedWorld({
      context, expected_terminal_tick: 40, journal, operator_timeout_ms: 5,
      port: { waitForWorldTerminal: () => new Promise(() => undefined) },
    }), /operator timeout/u);
    assert.equal(persisted.at(-1)?.current_phase, "running");
  });

  it("honors an operator signal independently of service completion", async () => {
    const { context, journal } = atTickOne();
    const controller = new AbortController();
    const pending = superviseComposedWorld({
      context, expected_terminal_tick: 40, journal, operator_timeout_ms: 1_000,
      port: { waitForWorldTerminal: () => new Promise(() => undefined) },
      signal: controller.signal,
    });
    controller.abort(new Error("operator interrupted"));
    await assert.rejects(pending, /operator interrupted/u);
  });
});
