import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { runDurableComposedRun } from "./recovery.js";
import { lifecycleRequest } from "./lifecycle.test-helper.js";
import { createComposedRunHarness } from "./run.test-helper.js";
import { WORLD_DECISION_CLAIM_CAPABILITY } from "./request.js";
import { parseComposedTerminalReceipt } from "./receipt.js";
import { composedCommandExitCode, createComposedCommandReceipt,
  parseComposedCommandReceipt, writeComposedFinalReceipt,
  writeComposedProgress } from "./commandReceipt.js";

const completed = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "simfile-command-receipt-"));
  const request = lifecycleRequest({ mode: "live",
    required_world_capabilities: [WORLD_DECISION_CLAIM_CAPABILITY] });
  const harness = createComposedRunHarness(request);
  let tick = 0;
  const result = await runDurableComposedRun({ configuration: harness.configuration,
    journal_path: path.join(root, "journal.json"),
    now: () => new Date(Date.UTC(2026, 7, 7, 12, 0, tick++)).toISOString(),
    ports: harness.ports, request });
  return { journal: result.journal, receipt: parseComposedTerminalReceipt(result.receipt) };
};
const liveEvidence = (blue = 1) => ({
  counts: [
    { count: blue, participant: "blue", principal: "principal:blue" },
    { count: 2, participant: "red", principal: "principal:red" },
  ],
  state: blue === 0 ? "failed" as const : "passed" as const,
  zero_action_principals: blue === 0 ? ["principal:blue"] : [],
});

describe("truthful composed command receipt", () => {
  it("correlates seal, cleanup, target, Moltnet, claim, counts, and viewer", async () => {
    const lifecycle = await completed();
    const receipt = createComposedCommandReceipt({ journal: lifecycle.journal,
      lifecycle_receipt: lifecycle.receipt, live_evidence: liveEvidence(),
      manifest_digest: `sha256:${"a".repeat(64)}`, run_path: "/runs/run-lifecycle",
      viewer: { state: "attached", url: "http://127.0.0.1:4400" } });
    assert.deepEqual(parseComposedCommandReceipt(receipt), receipt);
    assert.equal(receipt.world_claim.identity, WORLD_DECISION_CLAIM_CAPABILITY);
    assert.equal(receipt.world_claim.attested, true);
    assert.equal(receipt.moltnet?.capabilities[0], "pi-bridge");
    assert.equal(receipt.cleanup.remaining_owned_resources.length, 0);
    assert.equal(composedCommandExitCode(receipt), 0);
  });

  it("exits nonzero for live evidence only without invalidating mechanics", async () => {
    const lifecycle = await completed();
    const receipt = createComposedCommandReceipt({ journal: lifecycle.journal,
      lifecycle_receipt: lifecycle.receipt, live_evidence: liveEvidence(0),
      manifest_digest: `sha256:${"a".repeat(64)}`, run_path: "/runs/run-lifecycle",
      viewer: { state: "disabled" } });
    assert.equal(receipt.simulation_verdict, "valid");
    assert.equal(receipt.live_agent_evidence.state, "failed");
    assert.equal(composedCommandExitCode(receipt), 1);
  });

  it("prints progress only on stderr and one JSON receipt only on stdout", async () => {
    const lifecycle = await completed();
    const receipt = createComposedCommandReceipt({ journal: lifecycle.journal,
      lifecycle_receipt: lifecycle.receipt, live_evidence: liveEvidence(),
      manifest_digest: `sha256:${"a".repeat(64)}`, run_path: "/runs/run-lifecycle",
      viewer: { state: "unavailable", error: "renderer unavailable" } });
    let stdout = ""; let stderr = "";
    const out = process.stdout.write; const error = process.stderr.write;
    process.stdout.write = ((chunk: string | Uint8Array) => { stdout += chunk.toString(); return true; }) as typeof out;
    process.stderr.write = ((chunk: string | Uint8Array) => { stderr += chunk.toString(); return true; }) as typeof error;
    try { writeComposedProgress("world ready"); writeComposedFinalReceipt(receipt); }
    finally { process.stdout.write = out; process.stderr.write = error; }
    assert.equal(stderr, "world ready\n");
    assert.equal(stdout.trim().split("\n").length, 1);
    assert.deepEqual(parseComposedCommandReceipt(JSON.parse(stdout) as unknown), receipt);
  });

  it("rejects unattested claims, false cleanup, and secret-shaped additions", async () => {
    const lifecycle = await completed();
    assert.throws(() => parseComposedCommandReceipt({
      unexpected_token: "sk-secretsecretsecret",
    }), /secret-shaped/u);
    assert.throws(() => createComposedCommandReceipt({ journal: lifecycle.journal,
      lifecycle_receipt: { ...lifecycle.receipt, cleanup: {
        ...lifecycle.receipt.cleanup, state: "retained",
      } }, live_evidence: liveEvidence(), manifest_digest: `sha256:${"a".repeat(64)}`,
      run_path: "/runs/run-lifecycle", viewer: { state: "disabled" } }));
  });
});
