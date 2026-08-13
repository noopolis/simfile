import assert from "node:assert/strict";
import test from "node:test";

import { createDecisionRegistryForTesting } from "./decisionRegistry.js";
import {
  activateWorldDecisionClaim,
  claimWorldDecision,
  createWorldDecisionClaimAuthority,
  enableWorldDecisionClaim,
  registerWorldDecisionClaimAuthority,
  WORLD_DECISION_CLAIM_VALIDITY_TICKS,
} from "./decisionClaim.js";
import { WorldRuntimeError } from "./ledger.js";
import { runtimeFixture } from "./runtime.test-helper.js";

const denied = (error: unknown): boolean => error instanceof WorldRuntimeError
  && error.code === "world_runtime_denied"
  && !String(error).includes("opaque");

test("claim authority is activation-gated, single-owner, replay-safe, and replaceable after expiry", () => {
  let tick = 4;
  let entropy = 1;
  const registry = createDecisionRegistryForTesting({
    runId: "run-claim",
    worldInstanceId: "world-claim",
    tokenDigestKey: new Uint8Array(32).fill(7),
  }, { randomBytes: () => new Uint8Array(32).fill(entropy++) });
  const authority = createWorldDecisionClaimAuthority({
    decisionRegistry: registry,
    principals: new Set(["principal-red", "principal-blue"]),
    readTick: () => tick,
  });
  const runtime = {};
  registerWorldDecisionClaimAuthority(runtime, authority);
  assert.throws(() => claimWorldDecision(runtime, "principal-red", {
    request_id: "claim-red-1", wake_id: "schedule-red-1",
  }), denied);
  enableWorldDecisionClaim(runtime);
  assert.throws(() => claimWorldDecision(runtime, "principal-red", {
    request_id: "claim-red-1", wake_id: "schedule-red-1",
  }), denied);
  activateWorldDecisionClaim(runtime);
  const first = claimWorldDecision(runtime, "principal-red", {
    request_id: "claim-red-1", wake_id: "schedule-red-1",
  });
  assert.equal(first.issued_at_tick, 4);
  assert.equal(first.valid_through_tick, 4 + WORLD_DECISION_CLAIM_VALIDITY_TICKS);
  assert.match(first.decision_token, /^[A-Za-z0-9_-]+$/u);
  for (const [principal, request] of [
    ["principal-red", { request_id: "claim-red-1", wake_id: "schedule-red-1" }],
    ["principal-blue", { request_id: "claim-blue-1", wake_id: "schedule-red-1" }],
    ["principal-red", { request_id: "claim-red-2", wake_id: "schedule-red-2" }],
    ["principal-foreign", { request_id: "claim-foreign", wake_id: "schedule-foreign" }],
  ] as const) assert.throws(() => claimWorldDecision(runtime, principal, request), denied);

  tick = first.valid_through_tick + 1;
  const replacement = claimWorldDecision(runtime, "principal-red", {
    request_id: "claim-red-3", wake_id: "schedule-red-3",
  });
  assert.notEqual(replacement.decision_token, first.decision_token);
  assert.equal(registry.inspect().decisions.find((item) => item.decisionId === first.decision_id)?.status, "expired");
  assert.equal(registry.inspect().decisions.find((item) => item.decisionId === replacement.decision_id)?.status, "active");
});

test("the issued runtime keeps the base six-operation shape while the extension authenticates its registry", () => {
  const fixture = runtimeFixture();
  fixture.decisionRegistry.consumeForAct({ principal: "principal-red", runId: "run-1",
    worldInstanceId: "instance-1", token: fixture.red.token, atTick: 0 });
  assert.deepEqual(Object.keys(fixture.runtime), [
    "status", "capabilities", "observe", "affordances", "ledger", "act",
  ]);
  enableWorldDecisionClaim(fixture.runtime);
  activateWorldDecisionClaim(fixture.runtime);
  const claim = claimWorldDecision(fixture.runtime, "principal-red", {
    request_id: "runtime-claim-1", wake_id: "schedule-runtime-1",
  });
  const status = fixture.runtime.status({ principal: "principal-red",
    decisionToken: claim.decision_token });
  assert.equal(status.decision.id, claim.decision_id);
});
