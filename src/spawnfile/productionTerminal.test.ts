import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import test from "node:test";

import { digestComposedJson } from "../compose/json.js";
import {
  lifecycleDigest,
  tickOneLifecycleJournal,
} from "../compose/lifecycle.test-helper.js";
import {
  createComposedRunningReceipt,
  parseComposedWorldTerminalReceipt,
} from "../compose/supervision.js";
import { waitForProductionWorldTerminal } from "./productionTerminal.js";

const selectedTarget = {
  fingerprint: `sha256:${"1".repeat(32)}` as const,
  handle: "opaque_1111111111111111" as const,
};

const fixture = () => {
  const journal = tickOneLifecycleJournal();
  const running = createComposedRunningReceipt({
    activation_receipt_digest: lifecycleDigest("8"),
    first_tick_receipt_digest: lifecycleDigest("9"),
    run_id: journal.request.run_id,
  });
  return { journal, running };
};

const snapshot = (
  request: Readonly<Record<string, unknown>>,
  runId: string,
): Readonly<Record<string, unknown>> => {
  const content = Buffer.from(JSON.stringify({
    outcome_digest: lifecycleDigest("0"),
    reason: "completed",
    run_id: runId,
    terminal_tick: 4,
    version: "simfile.composed-world-terminal-signal.v1",
  }));
  return {
    artifact_id: "world_terminal",
    content_base64: content.toString("base64"),
    content_digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    media_type: "application/json",
    request_digest: digestComposedJson(
      "spawnfile.target-public-artifact-snapshot.request.v1", request,
    ),
    run_id: runId,
    size_bytes: content.byteLength,
    version: "spawnfile.target-public-artifact-snapshot.v1",
  };
};

const run = (
  runTarget: (
    command: string,
    request: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ) => Promise<unknown>,
  signal: AbortSignal = new AbortController().signal,
) => {
  const value = fixture();
  return waitForProductionWorldTerminal({
    journal: value.journal,
    poll_interval_ms: 1,
    provider: {
      terminal_artifact: {
        id: "world_terminal",
        max_bytes: 4_096,
        path: "/tmp/spawnfile-public/composed-terminal.json",
      },
    },
    run_target: runTarget,
    running: value.running,
    selected_target: selectedTarget,
    service_handle: "opaque_2222222222222222",
    signal,
  });
};

test("production terminal polling retries only the typed not-present condition", async () => {
  let calls = 0;
  const raw = await run(async (_command, request) => {
    calls += 1;
    if (calls === 1) return {
      artifact_id: "world_terminal",
      request_digest: digestComposedJson(
        "spawnfile.target-public-artifact-snapshot.request.v1", request,
      ),
      run_id: "run-lifecycle",
      status: "not_present",
      version: "spawnfile.target-public-artifact-snapshot.not-present.v1",
    };
    return snapshot(request, "run-lifecycle");
  });
  const receipt = parseComposedWorldTerminalReceipt(raw);
  assert.equal(receipt.terminal_tick, 4);
  assert.equal(calls, 2);
});

test("production terminal polling rejects uncorrelated not-present receipts", async () => {
  let calls = 0;
  await assert.rejects(run(async (_command, request) => {
    calls += 1;
    return {
      artifact_id: "world_terminal",
      request_digest: digestComposedJson(
        "spawnfile.target-public-artifact-snapshot.request.v1", request,
      ),
      run_id: "other-run",
      status: "not_present",
      version: "spawnfile.target-public-artifact-snapshot.not-present.v1",
    };
  }, AbortSignal.timeout(50)));
  assert.equal(calls, 1);
});

test("production terminal polling fails immediately on permanent target errors", async () => {
  const failure = new Error("permanent target failure");
  let calls = 0;
  await assert.rejects(run(async () => {
    calls += 1;
    throw failure;
  }, AbortSignal.timeout(50)), (error) => error === failure);
  assert.equal(calls, 1);
});

test("production terminal polling fails immediately on malformed target receipts", async () => {
  let calls = 0;
  await assert.rejects(run(async () => {
    calls += 1;
    return {};
  }, AbortSignal.timeout(50)));
  assert.equal(calls, 1);
});

test("production terminal abort clears its pending poll timer", async () => {
  const controller = new AbortController();
  const reason = new Error("stop terminal polling");
  let calls = 0;
  const pending = run(async (_command, request) => {
    calls += 1;
    queueMicrotask(() => controller.abort(reason));
    return {
      artifact_id: "world_terminal",
      request_digest: digestComposedJson(
        "spawnfile.target-public-artifact-snapshot.request.v1", request,
      ),
      run_id: "run-lifecycle",
      status: "not_present",
      version: "spawnfile.target-public-artifact-snapshot.not-present.v1",
    };
  }, controller.signal);
  await assert.rejects(pending, (error) => error === reason);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1);
});
