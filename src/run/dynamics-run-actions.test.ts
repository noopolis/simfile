import assert from "node:assert/strict";
import test from "node:test";

import type {
  DynamicsActionIngressRecord,
  DynamicsActionResult
} from "../dynamics/types.js";
import {
  assertDynamicsRunDecisionInvariant,
  createDynamicsRunDecisionEvidence,
  deriveDynamicsRunDecisionSource,
  joinDynamicsRunResult,
  NONE_DYNAMICS_RUN_DECISION_SOURCE,
  recordDynamicsRunDecisionIngress,
  recordDynamicsRunDecisionResult,
  resolveDynamicsRunProviderActionCauses
} from "./dynamics-run-actions.js";

const ingress = (
  origin: DynamicsActionIngressRecord["attempt"]["origin"],
  sequence = 1,
  actor = "red"
): DynamicsActionIngressRecord => ({
  attempt: {
    act_id: `${origin}:${sequence}`,
    action: "move",
    actor,
    at_tick: 0,
    input: { x: sequence },
    origin,
    principal_id: `${origin}:${actor}`,
    target: actor
  },
  receipt: {
    act_id: `${origin}:${sequence}`,
    apply_tick: 0,
    queued: true,
    sequence
  }
});

const result = (
  record: DynamicsActionIngressRecord,
  accepted = true
): DynamicsActionResult => ({
  accepted,
  act_id: record.attempt.act_id,
  action: record.attempt.action,
  actor: record.attempt.actor,
  apply_tick: record.receipt.apply_tick,
  origin: record.attempt.origin,
  principal_id: record.attempt.principal_id,
  sequence: record.receipt.sequence as number,
  target: record.attempt.target
});

const controllerIngress = ingress("controller");
const controllerResult = result(controllerIngress);
const agenticIngress = ingress("agentic", 2, "blue");
const agenticResult = result(agenticIngress);
const decisionEvidence = (
  ingressRecords: readonly DynamicsActionIngressRecord[],
  results: readonly DynamicsActionResult[]
) => {
  const evidence = createDynamicsRunDecisionEvidence();
  for (const record of ingressRecords) recordDynamicsRunDecisionIngress(evidence, record);
  for (const actionResult of results) recordDynamicsRunDecisionResult(evidence, actionResult);
  return evidence;
};

test('H1 "none" with an applied action is rejected directly', () => {
  assert.throws(
    () => assertDynamicsRunDecisionInvariant({
      decisionSource: NONE_DYNAMICS_RUN_DECISION_SOURCE,
      evidence: decisionEvidence([controllerIngress], [controllerResult])
    }),
    /decision_source "none" cannot coexist with an applied action/u
  );
});

test("H2 decision kind comes from actual origin, not declaration", () => {
  assert.equal(
    deriveDynamicsRunDecisionSource(
      decisionEvidence([controllerIngress], [controllerResult])
    ).kind,
    "controller"
  );
  assert.equal(
    deriveDynamicsRunDecisionSource(
      decisionEvidence([agenticIngress], [agenticResult])
    ).kind,
    "agent"
  );
  assert.equal(deriveDynamicsRunDecisionSource(decisionEvidence([], [])).kind, "none");
});

test("H3 mixed and unsupported origins fail closed", () => {
  assert.throws(
    () => deriveDynamicsRunDecisionSource(
      decisionEvidence(
        [controllerIngress, agenticIngress],
        [controllerResult, agenticResult]
      )
    ),
    /mixed participant action origins/u
  );
  const external = ingress("external");
  assert.throws(
    () => deriveDynamicsRunDecisionSource(decisionEvidence([external], [])),
    /unsupported local participant action origin external/u
  );
  const replay = ingress("replay");
  assert.throws(
    () => deriveDynamicsRunDecisionSource(decisionEvidence([replay], [])),
    /unsupported local participant action origin replay/u
  );
});

test("H8 a result must join its exact ingress provenance", () => {
  assert.throws(
    () => joinDynamicsRunResult(
      controllerIngress,
      { ...controllerResult, principal_id: "agent:forged" }
    ),
    /dynamics action result provenance mismatch/u
  );
});

test("decision actors are unique and code-point sorted", () => {
  const zed = ingress("controller", 1, "zed");
  const alpha = ingress("controller", 2, "alpha");
  const repeated = ingress("controller", 3, "zed");
  assert.deepEqual(
    deriveDynamicsRunDecisionSource(
      decisionEvidence(
        [zed, alpha, repeated],
        [result(zed), result(alpha), result(repeated)]
      )
    ).actors,
    ["alpha", "zed"]
  );
});

test("historic accepted provider causes retain declared sequence order", async () => {
  const accepted = new Map([[1, "event-1"], [4, "event-4"]]);
  assert.deepEqual(
    await resolveDynamicsRunProviderActionCauses(
      async (sequence) => accepted.get(sequence),
      [4, 1]
    ),
    ["event-4", "event-1"]
  );
  await assert.rejects(
    resolveDynamicsRunProviderActionCauses(
      async (sequence) => accepted.get(sequence),
      [2]
    ),
    /unknown accepted action sequence 2/u
  );
});

test("the stronger silence biconditional rejects rejected ingress labeled none", () => {
  const rejected = {
    ...controllerIngress,
    receipt: {
      act_id: controllerIngress.attempt.act_id,
      apply_tick: 1,
      code: "wrong_tick" as const,
      queued: false
    }
  };
  assert.throws(
    () => assertDynamicsRunDecisionInvariant({
      decisionSource: NONE_DYNAMICS_RUN_DECISION_SOURCE,
      evidence: decisionEvidence([rejected], [])
    }),
    /must exactly represent action silence/u
  );
});
