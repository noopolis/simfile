import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DYNAMICS_RUN_ACTION_SOURCE_VERSION } from
  "../dynamics/runActionSource.js";
import {
  createCanonicalEventEnvelope,
  type LedgerEventEnvelope,
} from "../ledger/stable.js";
import { createCanonicalLedgerEventValidator } from "../ledger/validation.js";
import { toCausalFixtureRecord } from "../runtime/trace.js";
import type { RuntimeTraceEvent } from "../runtime/types.js";
import {
  readWorldRuntimeActionRefusalJournalInspection,
} from "../world/actionJournalInspection.js";
import { readWorldRuntimeClockAuthority } from "../world/clockAuthority.js";
import { readWorldRuntimeControllerAuthority } from
  "../world/controllerAuthority.js";
import { reserveDecisionForAct } from "../world/decisionRegistry.js";
import {
  runtimeActEnvelope,
  runtimeFixtureWithHooks,
} from "../world/runtime.test-helper.js";
import { writeDynamicsRunActionTicks } from
  "./dynamics-run-action-ticks.js";
import { createDynamicsRunDecisionEvidence } from
  "./dynamics-run-actions.js";
import {
  createDynamicsRunActionSourceHost,
} from "./dynamics-run-action-source.js";
import { createDynamicsRunArtifactWriter } from
  "./dynamics-run-artifacts.js";

type Act = NonNullable<
  ReturnType<typeof runtimeFixtureWithHooks>["runtime"]
>["act"];
type Scenario = (act: Act, fixture: ReturnType<typeof runtimeFixtureWithHooks>) => void;

const jsonl = <Value>(source: string): Value[] => source.length === 0
  ? []
  : source.trimEnd().split("\n").map((line) => JSON.parse(line) as Value);

const recordScenario = async (
  runId: string,
  scenario: Scenario,
) => {
  const fixture = runtimeFixtureWithHooks({
    step: (input) => {
      const checked = input as {
        readonly actions: readonly { readonly sequence: number }[];
        readonly tick: number;
      };
      return {
        tick: checked.tick,
        events: [],
        action_results: checked.actions.map(({ sequence }) => ({
          accepted: true,
          sequence,
        })),
      };
    },
  }, true, { runId, worldInstanceId: `${runId}-world` });
  const runtime = fixture.runtime;
  assert.ok(runtime);
  const controller = readWorldRuntimeControllerAuthority(runtime);
  const clock = readWorldRuntimeClockAuthority(runtime);
  const refusals = readWorldRuntimeActionRefusalJournalInspection(runtime);
  assert.ok(controller);
  assert.ok(clock);
  assert.ok(refusals);

  const root = await mkdtemp(path.join(tmpdir(), "simfile-world-refusals-"));
  const writer = await createDynamicsRunArtifactWriter({
    outDir: path.join(root, "run"),
  });
  const source = Object.freeze({
    id: "world-refusal-source",
    live_acceptance: false as const,
    onTick: () => scenario(runtime.act.bind(runtime), fixture),
    participants: Object.freeze(["red", "blue"]),
    provenance: "scripted" as const,
    version: DYNAMICS_RUN_ACTION_SOURCE_VERSION,
  });
  const validator = createCanonicalLedgerEventValidator({
    runId,
    streamId: "world",
  });
  const appendLedger = async (event: LedgerEventEnvelope): Promise<void> => {
    const canonical = validator.validate(event);
    await writer.appendJsonl(
      "raw/world/causal.jsonl",
      toCausalFixtureRecord(canonical as RuntimeTraceEvent),
    );
  };
  const initial = createCanonicalEventEnvelope({
    runId,
    seq: 1,
    kind: "dynamics.session.initial",
    simTime: 0,
    provenance: "mechanical",
    actor: "system:simfile.dynamics",
    target: "world:pitch",
    scope: "world:pitch",
    payload: { tick: 0 },
  });
  try {
    await appendLedger(initial);
    await writeDynamicsRunActionTicks({
      appendLedger,
      decisionEvidence: createDynamicsRunDecisionEvidence(),
      dt: 1,
      clock: () => new Date("2026-01-02T03:04:05.000Z"),
      frames: { capture: async () => {} },
      host: createDynamicsRunActionSourceHost({
        participantHost: {
          controller,
          refusals,
          step: () => clock.stepDynamics().raw_step,
        },
        session: fixture.dynamics,
        source,
      }),
      initialEvidenceOrdinal: 0,
      previousStepEventId: initial.event_id,
      refusals,
      runId,
      scope: "world:pitch",
      seq: 2,
      session: fixture.dynamics,
      source,
      ticks: 1,
      writer,
    });
    return {
      attempts: await readFile(path.join(
        writer.stagingRealPath,
        "raw/action-attempts.jsonl",
      ), "utf8"),
      causal: await readFile(path.join(
        writer.stagingRealPath,
        "raw/world/causal.jsonl",
      ), "utf8"),
      refusals: await readFile(path.join(
        writer.stagingRealPath,
        "raw/world/action-refusals.jsonl",
      ), "utf8"),
      results: await readFile(path.join(
        writer.stagingRealPath,
        "raw/action-results.jsonl",
      ), "utf8"),
    };
  } finally {
    await writer.abort();
    await rm(root, { force: true, recursive: true });
  }
};

const threeActs: Scenario = (act, fixture) => {
  const accepted = act(
    { principal: "principal-red", decisionToken: fixture.red.token },
    runtimeActEnvelope("req-accepted", {
      affordance: "world://pitch/affordance/kick",
      target: "world://pitch/entity/ball",
      input: { force: 0.5 },
    }),
  );
  const refusedAffordance = act(
    { principal: "principal-blue", decisionToken: fixture.blue.token },
    runtimeActEnvelope("req-refused-a", {
      affordance: "world://pitch/affordance/kick",
      target: "world://pitch/entity/ball",
      input: { force: 1 },
    }),
  );
  const refusedTarget = act(
    { principal: "principal-blue", decisionToken: fixture.blue.token },
    runtimeActEnvelope("req-refused-b", {
      affordance: "world://pitch/affordance/wait",
      target: "world://pitch/entity/ball",
      input: { force: 1 },
    }),
  );
  assert.equal(accepted.disposition, "queued");
  assert.equal(refusedAffordance.disposition, "rejected_at_ingress");
  assert.equal(refusedAffordance.reason, "affordance_not_granted");
  assert.equal(refusedTarget.disposition, "rejected_at_ingress");
  assert.equal(refusedTarget.reason, "target_not_granted");
};

test("one accepted act and two world refusals remain distinguishable", async () => {
  const recorded = await recordScenario("world-refusal-run", threeActs);
  const attempts = jsonl<any>(recorded.attempts);
  const results = jsonl<any>(recorded.results);
  const refusals = jsonl<any>(recorded.refusals);
  const causal = jsonl<any>(recorded.causal);

  assert.equal(attempts.length, 1);
  assert.equal(results.length, 1);
  assert.equal(attempts[0]!.attempt.principal_id, "principal-red");
  assert.deepEqual(refusals, [{
    at_tick: 0,
    ordinal: 1,
    principal: "principal-blue",
    reason: "affordance_not_granted",
    version: "simfile.world-run-action-refusal.v2",
  }, {
    at_tick: 0,
    ordinal: 2,
    principal: "principal-blue",
    reason: "target_not_granted",
    version: "simfile.world-run-action-refusal.v2",
  }]);
  assert.equal(new Set(refusals.map(({ reason }) => reason)).size, 2);

  const refusalEvents = causal.filter(({ type }) =>
    type === "world.action.refused_at_ingress");
  assert.equal(refusalEvents.length, 2);
  assert.deepEqual(
    refusalEvents.map(({ payload }) => payload.reason),
    ["affordance_not_granted", "target_not_granted"],
  );
  assert.deepEqual(
    refusalEvents.map(({ cause_event_ids }) => cause_event_ids),
    [["simfile:world-refusal-run:1"], ["simfile:world-refusal-run:1"]],
  );
  assert.equal(refusalEvents.every(({ cause_event_ids }) =>
    cause_event_ids.length === 1), true);
  assert.equal(causal.filter(({ type }) => type === "dynamics.action.queued").length, 1);
});

test("consumed tokens remain distinguishable from genuine internal faults", async () => {
  const runId = "world-token-refusal-run";
  const recorded = await recordScenario(runId, (act, fixture) => {
    const accepted = act(
      { principal: "principal-red", decisionToken: fixture.red.token },
      runtimeActEnvelope("token-accepted", {
        affordance: "world://pitch/affordance/kick",
        target: "world://pitch/entity/ball",
        input: { force: 1 },
      }),
    );
    assert.equal(accepted.disposition, "queued");
    const consumed = act(
      { principal: "principal-red", decisionToken: fixture.red.token },
      runtimeActEnvelope("token-consumed", {
        affordance: "world://pitch/affordance/kick",
        target: "world://pitch/entity/ball",
        input: { force: 1 },
      }),
    );
    assert.equal(consumed.disposition, "rejected_at_ingress");
    assert.equal(consumed.reason, "decision_token_consumed");

    const held = reserveDecisionForAct(fixture.decisionRegistry, {
      principal: "principal-blue",
      runId,
      worldInstanceId: `${runId}-world`,
      token: fixture.blue.token,
      atTick: fixture.dynamics.nextTick,
    });
    const fault = act(
      { principal: "principal-blue", decisionToken: fixture.blue.token },
      runtimeActEnvelope("registry-reentrancy", {
        affordance: "world://pitch/affordance/wait",
        target: "world://pitch/entity/blue",
        input: { force: 1 },
      }),
    );
    assert.equal(fault.disposition, "rejected_at_ingress");
    assert.equal(fault.reason, "internal_error");
    held.abort();
  });

  assert.deepEqual(jsonl<any>(recorded.refusals), [{
    at_tick: 0,
    ordinal: 1,
    principal: "principal-red",
    reason: "decision_token_consumed",
    version: "simfile.world-run-action-refusal.v2",
  }, {
    at_tick: 0,
    ordinal: 2,
    principal: "principal-blue",
    reason: "internal_error",
    version: "simfile.world-run-action-refusal.v2",
  }]);
});

test("caller-authored world action bytes never enter refusal artifacts or causes", async () => {
  const marker = "b257-hostile-marker";
  const recorded = await recordScenario("world-hostile-refusal", (act, fixture) => {
    const receipt = act(
      { principal: "principal-red", decisionToken: fixture.red.token },
      runtimeActEnvelope(marker, {
        affordance: `world://pitch/affordance/${marker}`,
        target: `world://pitch/entity/${marker}`,
        input: { [`__proto__-ish-${marker}`]: marker },
      }),
    );
    assert.equal(receipt.disposition, "rejected_at_ingress");
  });
  assert.equal(recorded.refusals.includes(marker), false);
  assert.equal(recorded.causal.includes(marker), false);
  assert.equal(jsonl<any>(recorded.refusals)[0]!.reason, "affordance_not_granted");
});

test("identical world refusal scenarios produce byte-identical artifacts", async () => {
  const left = await recordScenario("world-refusal-determinism", threeActs);
  const right = await recordScenario("world-refusal-determinism", threeActs);
  assert.equal(left.refusals, right.refusals);
  assert.notEqual(left.refusals, "");
});
