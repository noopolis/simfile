import { createHash } from "node:crypto";

import { loadDynamicsRunActionSource } from "../dynamics/loadRunActionSource.js";
import { DYNAMICS_RUN_ACTION_SOURCE_VERSION } from "../dynamics/runActionSource.js";
import {
  createCanonicalEventEnvelope,
  stableStringify,
  type LedgerEventEnvelope
} from "../ledger/stable.js";
import {
  createCanonicalLedgerEventValidator,
  type CanonicalLedgerEventValidator
} from "../ledger/validation.js";
import { parseRunManifest, RUN_MANIFEST_VERSION } from "../observe/manifest.js";
import { toCausalFixtureRecord } from "../runtime/trace.js";
import type { RuntimeTraceEvent } from "../runtime/types.js";
import type { Simfile } from "../schema/model.js";
import { emptyProjectViewerExtensionsBytes } from "../viewer-extension/projectDeclaration.js";
import {
  assertDynamicsRunDecisionInvariant,
  createDynamicsRunDecisionEvidence,
  deriveDynamicsRunDecisionSource,
  DYNAMICS_RUN_STEP_RECORD_VERSION,
  NONE_DYNAMICS_RUN_DECISION_SOURCE
} from "./dynamics-run-actions.js";
import { writeDynamicsRunActionTicks } from "./dynamics-run-action-ticks.js";
import { dynamicsRunContractVersions } from "./dynamics-run-contract-versions.js";
import { createDynamicsRunFrameRecorder } from "./dynamics-run-frames.js";
import {
  createDynamicsRunActionSourceHost,
  type DynamicsRunParticipantHost
} from "./dynamics-run-action-source.js";
import { prepareDynamicsRunWorldGrants } from "./world-grant-run.js";
import {
  createDynamicsRunArtifactWriter,
  createOwnedScratchRoot,
  type DynamicsRunArtifactWriter,
  type DynamicsRunFileOperations,
  type OwnedScratchRoot
} from "./dynamics-run-artifacts.js";

export { DYNAMICS_RUN_STEP_RECORD_VERSION };
export const DYNAMICS_RUN_RECORD_VERSION = "simfile.dynamics-run.v1" as const;
export const DYNAMICS_RUN_PROVENANCE_VERSION =
  "simfile.dynamics-run-provenance.v1" as const;
export const DYNAMICS_RUN_REPLAY_INPUT_VERSION =
  "simfile.dynamics-run-replay-input.v1" as const;

export interface DynamicsRunRecordSeams {
  clock: () => Date;
  fileOperations?: DynamicsRunFileOperations;
  stagingParent?: string;
}

export interface DynamicsRunRecordOptions {
  outDir: string;
  participantHost?: DynamicsRunParticipantHost;
  runId: string;
  seams: DynamicsRunRecordSeams;
  seed: string;
  simfile: Simfile;
  simfilePath: string;
  sourceText: string;
  ticks: number;
  viewerExtensionsBytes?: Uint8Array;
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const worldScopeFor = (simfile: Simfile): string =>
  simfile.world === undefined ? "world:dynamics" : `world:${simfile.world.id}`;

const loadRun = async (
  options: DynamicsRunRecordOptions,
  writer: DynamicsRunArtifactWriter,
  scratch: OwnedScratchRoot
) => {
  let loaded: Awaited<ReturnType<typeof loadDynamicsRunActionSource>>;
  try {
    loaded = await loadDynamicsRunActionSource(options.simfile, {
      simfilePath: options.simfilePath,
      seed: options.seed,
      artifactLifecycle: {
        scratchRoot: scratch.path,
        evidenceRoot: writer.stagingRealPath
      }
    });
    if (loaded === undefined) {
      throw new Error("dynamics run dispatched without a dynamics declaration");
    }
  } catch (primary) {
    try {
      await scratch.remove();
    } catch (removeFailure) {
      throw new AggregateError(
        [primary, removeFailure],
        "dynamics session load and scratch cleanup both failed"
      );
    }
    throw primary;
  }
  await scratch.remove();
  return loaded;
};

const appendLedgerEvent = async (
  writer: DynamicsRunArtifactWriter,
  validator: CanonicalLedgerEventValidator,
  event: LedgerEventEnvelope
): Promise<void> => {
  const canonical = validator.validate(event);
  await writer.appendJsonl(
    "raw/world/causal.jsonl",
    toCausalFixtureRecord(canonical as RuntimeTraceEvent)
  );
};

export const writeDynamicsRunRecord = async (
  options: DynamicsRunRecordOptions
): Promise<{ outDir: string; runId: string }> => {
  const writer = await createDynamicsRunArtifactWriter({
    fileOperations: options.seams?.fileOperations,
    outDir: options.outDir,
    stagingParent: options.seams?.stagingParent
  });
  try {
    const scratch = await createOwnedScratchRoot(options.seams?.fileOperations);
    const loaded = await loadRun(options, writer, scratch);
    const session = loaded.session;
    const actionSource = loaded.actionSource;
    const initial = session.snapshot();
    const dt = initial.sim_seconds_per_tick;
    const clock = options.seams.clock;
    const scope = worldScopeFor(options.simfile);
    const worldGrants = prepareDynamicsRunWorldGrants({
      participantHost: options.participantHost,
      runId: options.runId,
      session,
      simfile: options.simfile,
      surfaceRegistry: loaded.surfaceRegistry
    });
    const ledgerValidator = createCanonicalLedgerEventValidator({
      runId: options.runId,
      streamId: "world"
    });
    const appendLedger = (event: LedgerEventEnvelope): Promise<void> =>
      appendLedgerEvent(writer, ledgerValidator, event);
    const decisionEvidence = createDynamicsRunDecisionEvidence(actionSource);
    let seq = 1;
    let providerEventCount = 0;

    const initialEvent = createCanonicalEventEnvelope({
      runId: options.runId,
      seq: seq++,
      kind: "dynamics.session.initial",
      simTime: 0,
      provenance: "mechanical",
      actor: "system:simfile.dynamics",
      target: scope,
      scope,
      payload: {
        tick: initial.next_tick,
        session_snapshot_sha256: sha256(stableStringify(initial))
      }
    });
    await appendLedger(initialEvent);
    let previousStepEventId = initialEvent.event_id;
    // Opens `raw/frames.jsonl` with its header and records the tick-0 frame
    // before any step, so the motion track starts at the same state
    // `replay/initial-session.json` seals.
    const frames = await createDynamicsRunFrameRecorder({ dt, session, writer });

    if (actionSource === undefined) {
      for (let tick = 0; tick < options.ticks; tick += 1) {
        const wallStartedAt = clock().getTime();
        const step = session.step();
        const wallElapsedSeconds = Math.max(
          0,
          (clock().getTime() - wallStartedAt) / 1000
        );
        if (step.action_results.length !== 0) {
          throw new Error("dynamics local run produced action results without an action source");
        }
        if ((step.commitment_outcomes?.length ?? 0) !== 0) {
          throw new Error("dynamics local run produced commitment outcomes without an action source");
        }
        const stepEvent = createCanonicalEventEnvelope({
          runId: options.runId,
          seq: seq++,
          kind: "dynamics.step",
          simTime: step.tick * dt,
          provenance: "mechanical",
          actor: "system:simfile.dynamics",
          target: scope,
          scope,
          causeEventIds: [previousStepEventId],
          payload: {
            from_tick: step.tick,
            to_tick: session.nextTick,
            accepted_action_sequences: [],
            rejected_action_sequences: []
          }
        });
        await appendLedger(stepEvent);

        const providerEventIds: string[] = [];
        for (const providerEvent of step.events) {
          if (providerEvent.cause_action_sequences.length !== 0) {
            throw new Error(
              "dynamics local run provider event referenced an action sequence"
            );
          }
          const event = createCanonicalEventEnvelope({
            runId: options.runId,
            seq: seq++,
            kind: providerEvent.kind,
            simTime: step.tick * dt,
            provenance: providerEvent.provenance,
            actor: providerEvent.source,
            target: providerEvent.target,
            scope,
            causeEventIds: [stepEvent.event_id],
            payload: providerEvent
          });
          await appendLedger(event);
          providerEventIds.push(event.event_id);
          providerEventCount += 1;
        }
        await writer.appendJsonl("raw/steps.jsonl", {
          version: DYNAMICS_RUN_STEP_RECORD_VERSION,
          from_tick: step.tick,
          to_tick: session.nextTick,
          sim_seconds_per_tick: dt,
          step_event_id: stepEvent.event_id,
          provider_event_ids: providerEventIds
        });
        previousStepEventId = stepEvent.event_id;
        // After the step, so the frame records the tick the session now sits at.
        await frames.capture(wallElapsedSeconds);
      }
    } else {
      const actionRun = await writeDynamicsRunActionTicks({
        appendLedger,
        clock,
        decisionEvidence,
        dt,
        frames,
        host: createDynamicsRunActionSourceHost({
          participantHost: worldGrants.participantHost,
          session,
          source: actionSource
        }),
        initialEvidenceOrdinal: initial.action_ingress_ordinal,
        previousStepEventId,
        refusals: worldGrants.participantHost?.refusals,
        readLedger: worldGrants.participantHost?.readLedger,
        readLedgerPrincipals: worldGrants.participantHost?.readLedgerPrincipals,
        runId: options.runId,
        scope,
        seq,
        session,
        source: actionSource,
        ticks: options.ticks,
        writer
      });
      previousStepEventId = actionRun.previousStepEventId;
      providerEventCount = actionRun.providerEventCount;
      seq = actionRun.seq;
    }

    const final = session.snapshot();
    const finalEvent = createCanonicalEventEnvelope({
      runId: options.runId,
      seq: seq++,
      kind: "dynamics.session.final",
      simTime: options.ticks * dt,
      provenance: "mechanical",
      actor: "system:simfile.dynamics",
      target: scope,
      scope,
      causeEventIds: [previousStepEventId],
      payload: {
        tick: final.next_tick,
        session_snapshot_sha256: sha256(stableStringify(final))
      }
    });
    await appendLedger(finalEvent);
    if (final.next_tick !== initial.next_tick + options.ticks) {
      throw new Error("dynamics run did not advance by the requested tick count");
    }
    const decisionSource = actionSource === undefined
      ? NONE_DYNAMICS_RUN_DECISION_SOURCE
      : deriveDynamicsRunDecisionSource(decisionEvidence);
    assertDynamicsRunDecisionInvariant({
      decisionSource,
      evidence: decisionEvidence
    });
    const actionSourceEvidence = actionSource === undefined ? "none" : {
      id: actionSource.id,
      live_acceptance: false,
      participants: actionSource.participants,
      provenance: actionSource.provenance,
      version: DYNAMICS_RUN_ACTION_SOURCE_VERSION
    };
    const grants = worldGrants.marker();

    const provenance = {
      version: DYNAMICS_RUN_PROVENANCE_VERSION,
      run_id: options.runId,
      action_source: actionSourceEvidence,
      decision_source: decisionSource,
      world_grants: grants,
      dynamics: initial.provenance,
      seed: initial.seed,
      sim_seconds_per_tick: dt,
      build_receipt_sha256: session.buildReceipt.receiptSha256,
      source: {
        path: options.simfilePath,
        sha256: sha256(options.sourceText)
      },
      ticks: options.ticks
    };
    const summary = {
      version: DYNAMICS_RUN_RECORD_VERSION,
      run_id: options.runId,
      name: options.simfile.name,
      ticks: options.ticks,
      initial_tick: initial.next_tick,
      final_tick: final.next_tick,
      provider_events: providerEventCount,
      decision_source: decisionSource,
      world_grants: grants,
      seed: options.seed
    };
    await writer.writeJson("provenance.json", provenance);
    await writer.writeActionReplay({
      finalCheckpoint: "replay/final-session.json",
      firstActionSequence: initial.next_action_sequence,
      initialCheckpoint: "replay/initial-session.json",
      runId: options.runId,
      version: DYNAMICS_RUN_REPLAY_INPUT_VERSION
    });
    await writer.writeJson("replay/final-session.json", final);
    await writer.writeJson("replay/initial-session.json", initial);
    await writer.writeJson("summary.json", summary);
    await writer.writeBytes(
      "viewer-extensions.json",
      options.viewerExtensionsBytes ?? emptyProjectViewerExtensionsBytes()
    );

    const receiptArtifactPath = session.buildReceipt.payload.artifact_path;
    const evidenceArtifactPath = receiptArtifactPath.startsWith("./")
      ? receiptArtifactPath.slice(2)
      : receiptArtifactPath;
    const expectedArtifactPath =
      `dynamics/sha256-${session.buildReceipt.payload.artifact_sha256}/provider.mjs`;
    if (evidenceArtifactPath !== expectedArtifactPath) {
      throw new Error("dynamics build receipt artifact path is not canonical");
    }
    const sealed = await writer.seal({
      evidenceArtifactPath,
      manifestFactory: (artifacts) => parseRunManifest({
        version: RUN_MANIFEST_VERSION,
        run_id: options.runId,
        created_at: clock().toISOString(),
        contract_versions: dynamicsRunContractVersions({
          hasActionSource: actionSource !== undefined,
          providerApiVersion: initial.provenance.api_version,
          provenanceVersion: DYNAMICS_RUN_PROVENANCE_VERSION,
          recordVersion: DYNAMICS_RUN_RECORD_VERSION,
          replayInputVersion: DYNAMICS_RUN_REPLAY_INPUT_VERSION,
          snapshotVersion: initial.version
        }),
        artifacts,
        engine: "simfile.dynamics.local",
        world: {
          created_at_basis: "wall-clock-instant-at-record-seal",
          decision_source: decisionSource,
          world_grants: grants,
          dynamics_provenance: initial.provenance,
          ticks: options.ticks,
          provider_events: providerEventCount
        }
      })
    });
    return { outDir: sealed.outDir, runId: options.runId };
  } catch (primary) {
    try {
      await writer.abort();
    } catch (abortFailure) {
      throw new AggregateError(
        [primary, abortFailure],
        "dynamics run failed and record abort also failed"
      );
    }
    throw primary;
  }
};
