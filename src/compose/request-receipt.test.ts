import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPOSED_RECOVERY_RECEIPT_VERSION,
  composedRecoveryCommand,
  createComposedRecoveryReceipt,
  createComposedTerminalReceipt,
  parseComposedRecoveryReceipt,
  parseComposedTerminalReceipt,
  verifyComposedTerminalReceipt,
} from "./receipt.js";
import { digestComposedJson } from "./json.js";
import {
  createComposedRunRequestDigest,
  parseComposedRunRequest,
  WORLD_DECISION_CLAIM_CAPABILITY,
} from "./request.js";

const sha = (value: string): `sha256:${string}` =>
  `sha256:${value.repeat(64).slice(0, 64)}`;
const request = parseComposedRunRequest({
  descriptor_digest: sha("a"),
  mode: "dry-run",
  organization: {
    artifact_digest: sha("b"),
    source_digest: sha("c"),
    world_bindings_digest: sha("d"),
  },
  required_world_capabilities: [],
  run_id: "run-one",
  source_digest: sha("e"),
  target: { auth_profile: "test-auth-profile", selector: "local-test-target" },
  version: "simfile.composed-run-request.v1",
  world: {
    artifact_manifest_digest: sha("f"),
    bundle_digest: sha("1"),
    runtime_abi: "simfile.world-sidecar-runtime.v1",
  },
});

const terminal = () => createComposedTerminalReceipt({
  cleanup: { receipt_digest: sha("2"), remaining_owned_resources: [], state: "cleaned" },
  evidence: {
    organization: { authority: "organization", digest: sha("3"), item_count: 4, state: "exported" },
    world: { authority: "world", digest: sha("4"), item_count: 5, state: "exported" },
  },
  journal_digest: sha("5"),
  request,
  seal: { digest: sha("6"), state: "sealed" },
  target: {
    preparation_receipt_digest: sha("7"),
    selected_target: {
      fingerprint: `sha256:${"8".repeat(32)}`,
      handle: `opaque_${"9".repeat(16)}`,
    },
    selector: "local-test-target",
  },
  topology: {
    activation_receipt_digest: sha("a"),
    receipt_digest: sha("b"),
    request_digest: sha("c"),
  },
  verdict: { digest: sha("d"), state: "valid" },
});

test("composed request and terminal receipt bind all public identities", () => {
  const receipt = terminal();
  assert.equal(receipt.run_id, request.run_id);
  assert.equal(receipt.request_digest, createComposedRunRequestDigest(request));
  assert.deepEqual(parseComposedTerminalReceipt(receipt), receipt);
  assert.deepEqual(verifyComposedTerminalReceipt(receipt, request, sha("5")), receipt);
});

test("live request requires the declared Phase 3 decision-claim capability hook", () => {
  assert.throws(() => parseComposedRunRequest({ ...request, mode: "live" }), /decision-claim/u);
  assert.doesNotThrow(() => parseComposedRunRequest({
    ...request,
    mode: "live",
    required_world_capabilities: [WORLD_DECISION_CLAIM_CAPABILITY],
  }));
  assert.throws(() => parseComposedRunRequest({
    ...request,
    mode: "lifecycle-replay-smoke",
    required_world_capabilities: [WORLD_DECISION_CLAIM_CAPABILITY],
  }));
});

test("terminal receipt rejects tamper, cross-run, unclean completion, and secret shapes", () => {
  const receipt = terminal();
  assert.throws(() => parseComposedTerminalReceipt({
    ...receipt,
    evidence: { ...receipt.evidence, world: { ...receipt.evidence.world, item_count: 6 } },
  }), /digest/u);
  assert.throws(() => verifyComposedTerminalReceipt(receipt, {
    ...request,
    run_id: "run-foreign",
  }), /correlation/u);
  assert.throws(() => createComposedTerminalReceipt({
    cleanup: {
      receipt_digest: sha("2"),
      remaining_owned_resources: [`opaque_${"e".repeat(16)}`],
      state: "cleaned",
    },
    evidence: receipt.evidence,
    journal_digest: sha("5"),
    request,
    seal: receipt.seal,
    target: receipt.target,
    topology: receipt.topology,
    verdict: receipt.verdict,
  }), /retains resources/u);
  assert.throws(() => parseComposedTerminalReceipt({ ...receipt, token: "sk-secretsecretsecret" }), /secret-shaped/u);
});

test("recovery receipt emits one exact idempotent command and rejects forgery", () => {
  const receipt = createComposedRecoveryReceipt({
    authority_digest: sha("d"),
    journal_digest: sha("e"),
    journal_path: "/tmp/run one's/journal.json",
    next_phase: "world_created",
    preserved_evidence: true,
    run_id: "run-one",
    signal: "SIGINT",
  });
  assert.equal(receipt.recovery_command,
    `simfile recover --journal '/tmp/run one'"'"'s/journal.json' --run-id 'run-one' --authority-digest '${sha("d")}'`);
  assert.deepEqual(parseComposedRecoveryReceipt(receipt), receipt);
  for (const recovery_command of [
    composedRecoveryCommand("/tmp/foreign.json", receipt.run_id, receipt.authority_digest),
    composedRecoveryCommand(receipt.journal_path, "run-foreign", receipt.authority_digest),
    composedRecoveryCommand(receipt.journal_path, receipt.run_id, sha("f")),
  ]) {
    const { receipt_digest: _digest, ...original } = receipt;
    const body = { ...original, recovery_command };
    assert.throws(() => parseComposedRecoveryReceipt({ ...body,
      receipt_digest: digestComposedJson(COMPOSED_RECOVERY_RECEIPT_VERSION, body),
    }), /command/u);
  }
});
