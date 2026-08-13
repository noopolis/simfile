import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DYNAMICS_RUN_ACTION_SOURCE_VERSION } from "../dynamics/runActionSource.js";
import type { DynamicsSession } from "../dynamics/session.js";
import type {
  DynamicsActionIngressEvidence,
  DynamicsActionIngressRecord,
  DynamicsActionQueueReceipt
} from "../dynamics/types.js";
import type { LedgerEventEnvelope } from "../ledger/stable.js";
import { createDynamicsRunDecisionEvidence } from "./dynamics-run-actions.js";
import { writeDynamicsRunActionTicks } from "./dynamics-run-action-ticks.js";
import type { DynamicsRunArtifactWriter } from "./dynamics-run-artifacts.js";

const evidence: DynamicsActionIngressEvidence = {
  ordinal: 1,
  record: {
    attempt: {
      act_id: "act-1",
      action: "advance",
      actor: "actor:one",
      at_tick: 0,
      input: { nested: { value: 1 } },
      origin: "controller",
      principal_id: "controller:one",
      target: "object:one"
    },
    receipt: { act_id: "act-1", apply_tick: 0, queued: true, sequence: 1 }
  }
};

type WriteActionTicksInput = Parameters<typeof writeDynamicsRunActionTicks>[0];

const source = {
  id: "source-one",
  live_acceptance: false as const,
  onTick: () => {},
  participants: [],
  provenance: "scripted" as const,
  version: DYNAMICS_RUN_ACTION_SOURCE_VERSION
};

const actionTicksInput = (
  root: string,
  session: DynamicsSession,
  writer: DynamicsRunArtifactWriter,
  appendLedger: WriteActionTicksInput["appendLedger"]
): WriteActionTicksInput => ({
  appendLedger,
  decisionEvidence: createDynamicsRunDecisionEvidence(),
  dt: 1,
  clock: () => new Date("2026-01-02T03:04:05.000Z"),
  frames: { capture: async () => {} },
  host: { notify: () => {}, settle: () => {} },
  initialEvidenceOrdinal: 0,
  previousStepEventId: "simfile:run-one:1",
  runId: "run-one",
  scope: "world:one",
  seq: 2,
  session,
  source,
  ticks: 1,
  writer
});

const ingress = (
  ordinal: number,
  actId: string,
  receipt: Readonly<{
    code?: DynamicsActionQueueReceipt["code"];
    queued: boolean;
    sequence?: number;
  }>
): DynamicsActionIngressEvidence => ({
  ordinal,
  record: {
    attempt: {
      act_id: actId,
      action: "advance",
      actor: `actor:${actId}`,
      at_tick: 0,
      input: {},
      origin: "controller",
      principal_id: `controller:${actId}`,
      target: `object:${actId}`
    },
    receipt: { act_id: actId, apply_tick: 0, ...receipt }
  }
});

const ingressSession = (
  ingressEvidence: readonly DynamicsActionIngressEvidence[],
  acknowledgments: number[],
  accepted = true
): DynamicsSession => {
  let nextTick = 0;
  return {
    get nextTick() { return nextTick; },
    acknowledgeActionIngressEvidence: (ordinal: number) => {
      acknowledgments.push(ordinal);
    },
    readActionIngressEvidence: () => ingressEvidence,
    step: () => {
      const tick = nextTick;
      nextTick += 1;
      return {
        action_results: ingressEvidence.flatMap(({ record }) => {
          const sequence = record.receipt.sequence;
          return record.receipt.queued && sequence !== undefined ? [{
            accepted,
            act_id: record.attempt.act_id,
            action: record.attempt.action,
            actor: record.attempt.actor,
            apply_tick: record.receipt.apply_tick,
            origin: record.attempt.origin,
            principal_id: record.attempt.principal_id,
            sequence,
            target: record.attempt.target
          }] : [];
        }),
        events: [],
        tick
      };
    }
  } as unknown as DynamicsSession;
};

test("does not acknowledge ingress evidence before every durable append succeeds", async () => {
  for (const failurePoint of ["attempt", "causal"] as const) {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-action-tick-"));
    const acknowledgments: number[] = [];
    const session = {
      get nextTick() { return 0; },
      acknowledgeActionIngressEvidence: (ordinal: number) => acknowledgments.push(ordinal),
      readActionIngressEvidence: () => [evidence],
      step: () => { throw new Error("step must not run after an append failure"); }
    } as unknown as DynamicsSession;
    const writer = {
      stagingRealPath: root,
      flush: async () => {},
      appendJsonl: async (relativePath: string) => {
        if (failurePoint === "attempt" && relativePath === "raw/action-attempts.jsonl") {
          throw new Error("injected attempt append failure");
        }
      }
    } as unknown as DynamicsRunArtifactWriter;
    try {
      await assert.rejects(writeDynamicsRunActionTicks(actionTicksInput(
        root,
        session,
        writer,
        async () => {
          if (failurePoint === "causal") throw new Error("injected causal append failure");
        }
      )), /injected .* append failure/u);
      assert.deepEqual(acknowledgments, []);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
});

test("does not acknowledge refusal evidence before its durable append succeeds", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "simfile-action-refusal-"));
  const acknowledgments: number[] = [];
  let nextTick = 0;
  const session = {
    get nextTick() { return nextTick; },
    acknowledgeActionIngressEvidence: () => {},
    readActionIngressEvidence: () => [],
    step: () => {
      const tick = nextTick;
      nextTick += 1;
      return { action_results: [], events: [], tick };
    }
  } as unknown as DynamicsSession;
  const writer = {
    stagingRealPath: root,
    appendJsonl: async () => {},
    flush: async () => { throw new Error("injected refusal flush failure"); }
  } as unknown as DynamicsRunArtifactWriter;
  const refusals = {
    read: () => [{
      ordinal: 1,
      refusal: { at_tick: 0, reason: "world_state_unstable" as const }
    }],
    acknowledge: (ordinal: number) => { acknowledgments.push(ordinal); }
  };
  try {
    await assert.rejects(writeDynamicsRunActionTicks({
      ...actionTicksInput(root, session, writer, async () => {}),
      refusals
    }), /injected refusal flush failure/u);
    assert.deepEqual(acknowledgments, []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("records distinguishable dynamics ingress rejection causes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "simfile-action-tick-"));
  const ingressEvidence = [
    ingress(1, "queued", { queued: true, sequence: 1 }),
    ingress(2, "wrong", { code: "wrong_tick", queued: false }),
    ingress(3, "conflict", { code: "act_id_conflict", queued: false })
  ];
  const acknowledgments: number[] = [];
  const ledgerEvents: LedgerEventEnvelope[] = [];
  const session = ingressSession(ingressEvidence, acknowledgments);
  const writer = {
    stagingRealPath: root,
    flush: async () => {},
    appendJsonl: async () => {}
  } as unknown as DynamicsRunArtifactWriter;
  try {
    await writeDynamicsRunActionTicks(actionTicksInput(
      root, session, writer, async (event) => { ledgerEvents.push(event); }
    ));
    const rejected = ledgerEvents.filter(({ kind }) =>
      kind === "dynamics.action.rejected_at_ingress");
    assert.equal(rejected.length, 2);
    const payloads = rejected.map(({ payload }) =>
      payload as DynamicsActionIngressRecord);
    const causes = payloads.map(({ receipt }) => receipt.code);
    assert.equal(new Set(causes).size, 2);
    assert.deepEqual(causes, ["wrong_tick", "act_id_conflict"]);
    assert.deepEqual(payloads.map(({ attempt }) => attempt.act_id), [
      "wrong", "conflict"
    ]);
    const queued = ledgerEvents.filter(({ kind }) =>
      kind === "dynamics.action.queued");
    assert.equal(queued.length, 1);
    assert.equal(
      (queued[0]?.payload as DynamicsActionIngressRecord).attempt.act_id,
      "queued"
    );
    assert.deepEqual(acknowledgments, [1, 2, 3]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rejects a causeless ingress receipt before durable output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "simfile-action-tick-"));
  const acknowledgments: number[] = [];
  const appendedPaths: string[] = [];
  const ledgerEvents: LedgerEventEnvelope[] = [];
  const session = ingressSession([
    ingress(1, "causeless", { queued: false })
  ], acknowledgments);
  const writer = {
    stagingRealPath: root,
    flush: async () => {},
    appendJsonl: async (relativePath: string) => { appendedPaths.push(relativePath); }
  } as unknown as DynamicsRunArtifactWriter;
  try {
    await assert.rejects(writeDynamicsRunActionTicks(actionTicksInput(
      root, session, writer, async (event) => { ledgerEvents.push(event); }
    )), /dynamics action causeless: a rejected ingress receipt must name its cause/u);
    assert.deepEqual(appendedPaths, []);
    assert.deepEqual(ledgerEvents, []);
    assert.deepEqual(acknowledgments, []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("keeps caller-authored strings out of the dynamics rejection cause", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "simfile-action-tick-"));
  const marker = `<script>hostile-cause-${"x".repeat(128)}`;
  const ingressEvidence: DynamicsActionIngressEvidence = {
    ordinal: 1,
    record: {
      attempt: {
        act_id: marker,
        action: marker,
        actor: marker,
        at_tick: 0,
        input: { nested: { value: marker } },
        origin: "controller",
        principal_id: marker,
        target: marker
      },
      receipt: {
        act_id: marker,
        apply_tick: 0,
        code: "wrong_tick",
        queued: false
      }
    }
  };
  const ledgerEvents: LedgerEventEnvelope[] = [];
  const writer = {
    stagingRealPath: root,
    flush: async () => {},
    appendJsonl: async () => {}
  } as unknown as DynamicsRunArtifactWriter;
  try {
    await writeDynamicsRunActionTicks(actionTicksInput(
      root,
      ingressSession([ingressEvidence], []),
      writer,
      async (event) => { ledgerEvents.push(event); }
    ));
    const rejected = ledgerEvents.filter(({ kind }) =>
      kind === "dynamics.action.rejected_at_ingress");
    assert.equal(rejected.length, 1);
    const payload = rejected[0]?.payload as DynamicsActionIngressRecord;
    assert.equal(JSON.stringify(payload.attempt).includes(marker), true);
    assert.equal(payload.receipt.code, "wrong_tick");
    assert.equal(payload.receipt.code.includes(marker), false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("writes distinct controller principals through the ledger writer path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "simfile-action-tick-"));
  const ingressEvidence: readonly DynamicsActionIngressEvidence[] = [
    ingress(1, "one", { queued: true, sequence: 1 }),
    ingress(2, "two", { queued: true, sequence: 2 })
  ];
  const ledgerEvents: LedgerEventEnvelope[] = [];
  const session = ingressSession(ingressEvidence, [], false);
  const writer = {
    stagingRealPath: root,
    flush: async () => {},
    appendJsonl: async () => {}
  } as unknown as DynamicsRunArtifactWriter;

  try {
    await writeDynamicsRunActionTicks(actionTicksInput(
      root,
      session,
      writer,
      async (event) => { ledgerEvents.push(event); }
    ));

    const ingressEvents = ledgerEvents.filter((event) =>
      event.kind === "dynamics.action.queued"
    );
    assert.equal(ingressEvents.length, 2);
    assert.notEqual(ingressEvents[0]?.principal_id, ingressEvents[1]?.principal_id);
    assert.equal(ingressEvents[0]?.principal_id, "system:simfile.controller.one");
    assert.equal(ingressEvents[1]?.principal_id, "system:simfile.controller.two");
    const resultEvents = ledgerEvents.filter((event) =>
      event.kind === "dynamics.action.rejected_by_mechanics"
    );
    assert.equal(resultEvents.length, 2);
    assert.equal(resultEvents[0]?.principal_id, "system:simfile.controller.one");
    assert.equal(resultEvents[1]?.principal_id, "system:simfile.controller.two");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("records a terminal commitment with step and declaration causes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "simfile-commitment-tick-"));
  let nextTick = 0;
  const appended: Array<{ path: string; value: any }> = [];
  const ledger: any[] = [];
  const session = {
    get nextTick() { return nextTick; },
    acknowledgeActionIngressEvidence: () => {},
    readActionIngressEvidence: () => nextTick === 0 ? [evidence] : [],
    step: () => {
      nextTick = 1;
      return {
        action_results: [{
          accepted: true,
          act_id: "act-1",
          action: "advance",
          actor: "actor:one",
          apply_tick: 0,
          origin: "controller",
          principal_id: "controller:one",
          sequence: 1,
          target: "object:one",
        }],
        commitment_outcomes: [{
          commitment_id: "commitment:one:1",
          declaration_action_sequence: 1,
          outcome: "fulfilled",
          participant: "object:one",
          provenance: "mechanical",
          tick: 0,
        }],
        events: [],
        tick: 0,
      };
    },
  } as unknown as DynamicsSession;
  const writer = {
    stagingRealPath: root,
    flush: async () => {},
    appendJsonl: async (relativePath: string, value: unknown) => {
      appended.push({ path: relativePath, value });
    },
  } as unknown as DynamicsRunArtifactWriter;
  try {
    await writeDynamicsRunActionTicks(actionTicksInput(
      root,
      session,
      writer,
      async (entry) => { ledger.push(entry); }
    ));
    assert.deepEqual(
      appended.find(({ path }) => path === "raw/commitment-outcomes.jsonl")?.value,
      {
        outcome: {
          commitment_id: "commitment:one:1",
          declaration_action_sequence: 1,
          outcome: "fulfilled",
          participant: "object:one",
          provenance: "mechanical",
          tick: 0,
        },
        source: {
          id: "source-one",
          live_acceptance: false,
          provenance: "scripted",
        },
        version: "simfile.dynamics-run-commitment-outcome.v1",
      },
    );
    const terminal = ledger.find(({ kind }) =>
      kind === "dynamics.commitment.outcome");
    assert.deepEqual(terminal.cause_event_ids, [
      "simfile:run-one:4",
      "simfile:run-one:3",
    ]);
    assert.equal(terminal.actor, "object:one");
    assert.equal(terminal.target, "object:one");
    assert.equal(terminal.payload.declaration_action_sequence, 1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
