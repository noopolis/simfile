import type {
  DynamicsRunActionSourceDeclaration
} from "../dynamics/runActionSource.js";
import type { DynamicsSession } from "../dynamics/session.js";
import type {
  DynamicsActionAttempt,
  DynamicsActionIngressRecord,
  DynamicsActionResult
} from "../dynamics/types.js";
import {
  createCanonicalEventEnvelope,
  type LedgerEventEnvelope
} from "../ledger/stable.js";
import { resolveCausalPrincipal } from "../ledger/principal.js";
import type {
  WorldActionRefusal,
  WorldActionRefusalReadPort,
} from "../world/actionRefusalJournal.js";
import type { WorldReadLedger } from "../world/ledger.js";
import type { DynamicsRunActionSourceHost } from "./dynamics-run-action-source.js";
import { createDynamicsRunActionCauseIndex } from "./dynamics-run-action-causes.js";
import {
  DYNAMICS_RUN_ACTION_INGRESS_VERSION,
  DYNAMICS_RUN_ACTION_RESULT_VERSION,
  DYNAMICS_RUN_STEP_RECORD_VERSION,
  joinDynamicsRunResult,
  recordDynamicsRunDecisionIngress,
  recordDynamicsRunDecisionResult,
  resolveDynamicsRunProviderActionCauses,
  type DynamicsRunDecisionEvidence,
  type DynamicsRunActionSourceEvidence
} from "./dynamics-run-actions.js";
import type { DynamicsRunArtifactWriter } from "./dynamics-run-artifacts.js";
import type { DynamicsRunFrameRecorder } from "./dynamics-run-frames.js";
import { createDynamicsRunCommitmentOutcomeRecord } from
  "./dynamics-run-commitment-outcomes.js";
import { WORLD_RUN_ACTION_REFUSAL_VERSION } from
  "./dynamics-run-contract-versions.js";
import { drainDynamicsRunPerceptions } from "./dynamics-run-world-evidence.js";

const sourceEvidence = (
  source: DynamicsRunActionSourceDeclaration
): DynamicsRunActionSourceEvidence => Object.freeze({
  id: source.id,
  live_acceptance: false,
  provenance: source.provenance
});

const causalProvenance = (
  origin: DynamicsActionAttempt["origin"]
): "agentic" | "external" =>
  origin === "agentic" ? "agentic" : "external";

export interface DynamicsRunActionTicksResult {
  readonly previousStepEventId: string;
  readonly providerEventCount: number;
  readonly seq: number;
}

const worldActionRefusalRecord = (
  ordinal: number,
  refusal: WorldActionRefusal,
) => Object.freeze({
  version: WORLD_RUN_ACTION_REFUSAL_VERSION,
  ordinal,
  at_tick: refusal.at_tick,
  ...(refusal.principal === undefined ? {} : { principal: refusal.principal }),
  reason: refusal.reason,
  ...(refusal.field_path === undefined
    ? {}
    : { field_path: refusal.field_path }),
});

export const writeDynamicsRunActionTicks = async (input: Readonly<{
  appendLedger(event: LedgerEventEnvelope): Promise<void>;
  decisionEvidence: DynamicsRunDecisionEvidence;
  dt: number;
  clock: () => Date;
  host: DynamicsRunActionSourceHost;
  initialEvidenceOrdinal: number;
  previousStepEventId: string;
  refusals?: WorldActionRefusalReadPort;
  readLedger?: WorldReadLedger;
  readLedgerPrincipals?: readonly string[];
  runId: string;
  scope: string;
  seq: number;
  session: DynamicsSession;
  frames: DynamicsRunFrameRecorder;
  source: DynamicsRunActionSourceDeclaration;
  ticks: number;
  writer: DynamicsRunArtifactWriter;
}>): Promise<DynamicsRunActionTicksResult> => {
  const actionCauses = await createDynamicsRunActionCauseIndex(
    input.writer.stagingRealPath,
    input.runId
  );
  const evidence = sourceEvidence(input.source);
  let evidenceOrdinal = input.initialEvidenceOrdinal;
  let refusalOrdinal = 0;
  let previousStepEventId = input.previousStepEventId;
  let providerEventCount = 0;
  let seq = input.seq;
  const perceptionAfter = new Map<string, number>();
  const initialNextTick = input.session.nextTick;
  const clock = input.clock;

  try {
    for (let offset = 0; offset < input.ticks; offset += 1) {
    if (input.session.nextTick !== initialNextTick + offset) {
      throw new Error("dynamics run action tick did not advance canonically");
    }
    const ingressBySequence = new Map<number, DynamicsActionIngressRecord>();
    const ingressEventBySequence = new Map<number, string>();
    const wallStartedAt = clock().getTime();
    input.host.notify(input.session.nextTick * input.dt);
    const ingressEvidence = input.session.readActionIngressEvidence(evidenceOrdinal);
    for (const entry of ingressEvidence) {
      const record = entry.record;
      // This stream remains dynamics-only. World refusals happen before
      // queueAction and are drained from the separate host refusal port below.
      if (!record.receipt.queued && record.receipt.code === undefined) {
        throw new Error(
          `dynamics action ${record.attempt.act_id}: a rejected ingress receipt must name its cause`
        );
      }
      await input.writer.appendJsonl("raw/action-attempts.jsonl", {
        version: DYNAMICS_RUN_ACTION_INGRESS_VERSION,
        source: evidence,
        attempt: record.attempt,
        receipt: record.receipt
      });
      const event = createCanonicalEventEnvelope({
        runId: input.runId,
        seq: seq++,
        kind: record.receipt.queued
          ? "dynamics.action.queued"
          : "dynamics.action.rejected_at_ingress",
        simTime: record.receipt.apply_tick * input.dt,
        provenance: causalProvenance(record.attempt.origin),
        actor: record.attempt.actor,
        target: record.attempt.target,
        scope: input.scope,
        principalId: resolveCausalPrincipal({
          origin: record.attempt.origin,
          principalId: record.attempt.principal_id
        }),
        causeEventIds: [previousStepEventId],
        payload: { attempt: record.attempt, receipt: record.receipt }
      });
      await input.appendLedger(event);
      await input.writer.flush();
      input.session.acknowledgeActionIngressEvidence(entry.ordinal);
      evidenceOrdinal = entry.ordinal;
      recordDynamicsRunDecisionIngress(input.decisionEvidence, record);
      if (record.receipt.queued && record.receipt.sequence !== undefined) {
        if (!ingressBySequence.has(record.receipt.sequence)) {
          ingressBySequence.set(record.receipt.sequence, record);
          ingressEventBySequence.set(record.receipt.sequence, event.event_id);
        }
      }
    }

    const refusalEvidence = [...(input.refusals?.read(refusalOrdinal) ?? [])]
      .sort((left, right) => left.ordinal - right.ordinal);
    for (const entry of refusalEvidence) {
      if (!Number.isSafeInteger(entry.ordinal) || entry.ordinal <= refusalOrdinal) {
        throw new Error("world action refusal stream is not ordinal");
      }
      const record = worldActionRefusalRecord(entry.ordinal, entry.refusal);
      await input.writer.appendJsonl("raw/world/action-refusals.jsonl", record);
      await input.appendLedger(createCanonicalEventEnvelope({
        runId: input.runId,
        seq: seq++,
        kind: "world.action.refused_at_ingress",
        simTime: entry.refusal.at_tick * input.dt,
        provenance: "agentic",
        actor: entry.refusal.principal ?? "system:simfile.world",
        target: input.scope,
        scope: input.scope,
        ...(entry.refusal.principal === undefined ? {} : {
          principalId: resolveCausalPrincipal({
            origin: "agentic",
            principalId: entry.refusal.principal,
          }),
        }),
        causeEventIds: [previousStepEventId],
        payload: record,
      }));
      await input.writer.flush();
      input.refusals?.acknowledge(entry.ordinal);
      refusalOrdinal = entry.ordinal;
    }

    if (input.readLedger !== undefined && input.readLedgerPrincipals !== undefined) {
      seq = await drainDynamicsRunPerceptions({
        after: perceptionAfter,
        appendLedger: input.appendLedger,
        ledger: input.readLedger,
        principals: input.readLedgerPrincipals,
        previousStepEventId,
        runId: input.runId,
        scope: input.scope,
        seq,
        simTime: input.session.nextTick * input.dt,
        writer: input.writer
      });
    }

    const rawStep = input.host.step?.() ?? input.session.step();
    if (input.host.stepSettles !== true) input.host.settle(rawStep);
    const wallElapsedSeconds = Math.max(
      0,
      (clock().getTime() - wallStartedAt) / 1000
    );
    const resultEventIds: string[] = [];
    const accepted: number[] = [];
    const rejected: number[] = [];
    for (const result of rawStep.action_results) {
      const admitted = ingressBySequence.get(result.sequence);
      if (admitted === undefined) {
        throw new Error(
          `dynamics action result sequence ${result.sequence} has no recorded ingress`
        );
      }
      joinDynamicsRunResult(admitted, result);
      await input.writer.appendJsonl("raw/action-results.jsonl", {
        version: DYNAMICS_RUN_ACTION_RESULT_VERSION,
        source: evidence,
        result
      });
      const ingressEventId = ingressEventBySequence.get(result.sequence);
      if (ingressEventId === undefined) {
        throw new Error("dynamics action result has no ingress causal event");
      }
      const event = createCanonicalEventEnvelope({
        runId: input.runId,
        seq: seq++,
        kind: result.accepted
          ? "dynamics.action.applied"
          : "dynamics.action.rejected_by_mechanics",
        simTime: result.apply_tick * input.dt,
        provenance: causalProvenance(result.origin),
        actor: result.actor,
        target: result.target,
        scope: input.scope,
        principalId: resolveCausalPrincipal({
          origin: admitted.attempt.origin,
          principalId: admitted.attempt.principal_id
        }),
        causeEventIds: [ingressEventId],
        payload: result
      });
      await input.appendLedger(event);
      recordDynamicsRunDecisionResult(input.decisionEvidence, result);
      resultEventIds.push(event.event_id);
      (result.accepted ? accepted : rejected).push(result.sequence);
      if (result.accepted) {
        const ledgerSequence = event.emitter?.seq;
        if (ledgerSequence === undefined) {
          throw new Error("dynamics action result event has no ledger sequence");
        }
        await actionCauses.record(result.sequence, ledgerSequence);
      }
    }

    const stepEvent = createCanonicalEventEnvelope({
      runId: input.runId,
      seq: seq++,
      kind: "dynamics.step",
      simTime: rawStep.tick * input.dt,
      provenance: "mechanical",
      actor: "system:simfile.dynamics",
      target: input.scope,
      scope: input.scope,
      causeEventIds: [previousStepEventId, ...resultEventIds],
      payload: {
        from_tick: rawStep.tick,
        to_tick: input.session.nextTick,
        accepted_action_sequences: accepted,
        rejected_action_sequences: rejected
      }
    });
    await input.appendLedger(stepEvent);

    const providerEventIds: string[] = [];
    for (const providerEvent of rawStep.events) {
      const providerActionCauses = await resolveDynamicsRunProviderActionCauses(
        actionCauses.lookup,
        providerEvent.cause_action_sequences
      );
      const event = createCanonicalEventEnvelope({
        runId: input.runId,
        seq: seq++,
        kind: providerEvent.kind,
        simTime: rawStep.tick * input.dt,
        provenance: providerEvent.provenance,
        actor: providerEvent.source,
        target: providerEvent.target,
        scope: input.scope,
        causeEventIds: [stepEvent.event_id, ...providerActionCauses],
        payload: providerEvent
      });
      await input.appendLedger(event);
      providerEventIds.push(event.event_id);
      providerEventCount += 1;
    }
    for (const outcome of rawStep.commitment_outcomes ?? []) {
      const declarationEventId = await actionCauses.lookup(
        outcome.declaration_action_sequence,
      );
      if (declarationEventId === undefined) {
        throw new Error("dynamics commitment outcome has no declaration cause");
      }
      await input.writer.appendJsonl(
        "raw/commitment-outcomes.jsonl",
        createDynamicsRunCommitmentOutcomeRecord(evidence, outcome),
      );
      await input.appendLedger(createCanonicalEventEnvelope({
        runId: input.runId,
        seq: seq++,
        kind: "dynamics.commitment.outcome",
        simTime: outcome.tick * input.dt,
        provenance: outcome.provenance,
        actor: outcome.participant,
        target: outcome.counterparty ?? outcome.participant,
        scope: input.scope,
        causeEventIds: [stepEvent.event_id, declarationEventId],
        payload: outcome,
      }));
    }
    await input.writer.appendJsonl("raw/steps.jsonl", {
      version: DYNAMICS_RUN_STEP_RECORD_VERSION,
      from_tick: rawStep.tick,
      to_tick: input.session.nextTick,
      sim_seconds_per_tick: input.dt,
      step_event_id: stepEvent.event_id,
      provider_event_ids: providerEventIds
    });
    previousStepEventId = stepEvent.event_id;
    // After the step, so the frame records the tick the session now sits at.
    await input.frames.capture(wallElapsedSeconds);
  }
    return { previousStepEventId, providerEventCount, seq };
  } finally {
    await actionCauses.close();
  }
};
