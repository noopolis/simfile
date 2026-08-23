import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runDurableComposedRun } from "./recovery.js";
import { lifecycleRequest } from "./lifecycle.test-helper.js";
import { createComposedRunHarness } from "./run.test-helper.js";
import { WORLD_DECISION_CLAIM_CAPABILITY } from "./request.js";
import { parseComposedTerminalReceipt } from "./receipt.js";
import {
  createComposedLifecycleReplaySmokeReceipt,
  parseComposedLifecycleReplaySmokeReceipt,
  serializeComposedLifecycleReplaySmokeReceipt,
} from "./smokeCommandReceipt.js";
import { verifyComposedTerminalOutcome } from "./terminalOutcome.js";

const completed = async (mode: "dry-run" | "live") => {
  const root = await mkdtemp(path.join(tmpdir(), "simfile-smoke-receipt-"));
  const request = lifecycleRequest({
    mode,
    required_world_capabilities: [WORLD_DECISION_CLAIM_CAPABILITY],
  });
  const harness = createComposedRunHarness(request);
  let tick = 0;
  const result = await runDurableComposedRun({
    configuration: harness.configuration,
    journal_path: path.join(root, "journal.json"),
    now: () => new Date(Date.UTC(2026, 7, 7, 12, 0, tick++)).toISOString(),
    ports: harness.ports,
    request,
  });
  return {
    journal: result.journal,
    receipt: parseComposedTerminalReceipt(result.receipt),
  };
};

const replay = {
  accepted_action_count: 0,
  exact: true as const,
  probe_sha256: "a".repeat(64),
  run_id: "run-lifecycle",
  terminal_state_sha256: "0".repeat(64),
  terminal_tick: 4,
  version: "simfile.composed-replay-receipt.v1" as const,
};

test("lifecycle/replay smoke receipt reports live action as not evaluated", async () => {
  const lifecycle = await completed("live");
  assert.equal(verifyComposedTerminalOutcome(
    lifecycle.journal, replay,
  ).outcome_digest, `sha256:${"0".repeat(64)}`);
  assert.throws(() => verifyComposedTerminalOutcome(lifecycle.journal, {
    ...replay, terminal_state_sha256: "b".repeat(64),
  }),
    /does not match exact replay/u);
  const receipt = createComposedLifecycleReplaySmokeReceipt({
    journal: lifecycle.journal,
    lifecycle_receipt: lifecycle.receipt,
    manifest_digest: `sha256:${"c".repeat(64)}`,
    replay,
    run_path: "/runs/run-lifecycle",
    viewer: { state: "disabled" },
  });
  assert.deepEqual(parseComposedLifecycleReplaySmokeReceipt(receipt), receipt);
  assert.equal(receipt.mode, "lifecycle-replay-smoke");
  assert.equal(receipt.lifecycle_replay_verdict, "passed");
  assert.deepEqual(receipt.live_agent_evidence, { state: "not_evaluated" });
  assert.equal("simulation_verdict" in receipt, false);
  assert.equal(serializeComposedLifecycleReplaySmokeReceipt(receipt)
    .trim().split("\n").length, 1);
});

test("smoke receipt rejects dry-run lifecycle and correlation or digest forgery", async () => {
  const lifecycle = await completed("dry-run");
  assert.throws(() => createComposedLifecycleReplaySmokeReceipt({
    journal: lifecycle.journal,
    lifecycle_receipt: lifecycle.receipt,
    manifest_digest: `sha256:${"c".repeat(64)}`,
    replay,
    run_path: "/runs/run-lifecycle",
    viewer: { state: "disabled" },
  }), /smoke completion proof/u);

  const smoke = await completed("live");
  const receipt = createComposedLifecycleReplaySmokeReceipt({
    journal: smoke.journal,
    lifecycle_receipt: smoke.receipt,
    manifest_digest: `sha256:${"c".repeat(64)}`,
    replay,
    run_path: "/runs/run-lifecycle",
    viewer: { state: "disabled" },
  });
  assert.throws(() => parseComposedLifecycleReplaySmokeReceipt({
    ...receipt,
    live_agent_evidence: { state: "passed" },
  }));
  assert.throws(() => parseComposedLifecycleReplaySmokeReceipt({
    ...receipt,
    exact_replay: { ...receipt.exact_replay, run_id: "other-run" },
  }), /digest|correlation/u);
});
