import {
  assertComposedDecisionInputs,
  attachComposedViewer,
  composedCommandExitCode,
  composedRunConfiguration,
  createComposedCommandReceipt,
  createComposedJournalSession,
  createComposedLiveViewerProjection,
  createComposedPhaseJournal,
  deriveComposedLiveEvidence,
  replayComposedRunRecord,
  runPreflightedComposedRun,
  serializeComposedReceipt,
  writeComposedFinalReceipt,
  writeComposedProgress,
  type CompletedComposedRun,
  type ComposedViewerAttachment,
  type ComposedLiveViewerProjection,
} from "../compose/index.js";
import type { Simfile } from "../schema/index.js";
import { createProductionComposedRunPorts } from "../spawnfile/productionPorts.js";
import {
  bindTerminalViewerProjection,
  startProductionViewerProjection,
  type ProductionViewerProjectionObserver,
} from "../spawnfile/productionViewerProjection.js";
import { prepareLinkedComposedRun, revokeLinkedComposedSources } from
  "./composedRunBootstrap.js";
import { createLinkedComposedRecord, sealLinkedComposedRecord } from
  "./composedRunArtifacts.js";
import type { ParsedRunOptions } from "./runArguments.js";

export interface LinkedComposedRunInput {
  readonly linked_spawnfile_path: string;
  readonly options: ParsedRunOptions;
  readonly simfile: Simfile;
  readonly simfile_path: string;
  readonly source_text: string;
}

export type LinkedComposedRunCommand = (
  input: LinkedComposedRunInput,
) => Promise<number>;

const recoveryExitCode = (signal: "SIGINT" | "SIGTERM" | "failure" | "restart"): number =>
  signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1;
const receiptViewer = (
  attachment: ComposedViewerAttachment | undefined,
  projectionError?: string,
) => {
  if (attachment === undefined) return { state: "disabled" as const };
  if (projectionError !== undefined) {
    return { error: projectionError, state: "unavailable" as const };
  }
  if (attachment.state === "attached") {
    return { state: "attached" as const, url: attachment.url };
  }
  return { error: attachment.error, state: "unavailable" as const };
};

/** Owns the one production route into the generic composed lifecycle. */
export const runLinkedComposedCommand: LinkedComposedRunCommand = async (input) => {
  assertComposedDecisionInputs({ simfile: input.simfile });
  writeComposedProgress("Preparing linked composed run");
  const bootstrap = await prepareLinkedComposedRun(input);
  let record;
  try {
    record = await createLinkedComposedRecord(bootstrap);
  } catch (error) {
    await revokeLinkedComposedSources(bootstrap);
    throw error;
  }
  const initial = createComposedPhaseJournal(
    bootstrap.request, new Date().toISOString(), bootstrap.execution,
  );
  const session = await createComposedJournalSession(bootstrap.journal_path, initial);
  let viewer: ComposedViewerAttachment | undefined;
  let projection: ComposedLiveViewerProjection | undefined;
  let projectionObserver: ProductionViewerProjectionObserver | undefined;
  let projectionError: string | undefined;
  if (input.options.view) {
    viewer = await attachComposedViewer({ run_dir: record.out_dir,
      trusted_project_root: bootstrap.trusted_project_root });
    if (viewer.state === "attached") {
      writeComposedProgress(`Viewer: ${viewer.url}`);
      if (bootstrap.preparation.viewer?.live_trace !== undefined) {
        try {
          projection = createComposedLiveViewerProjection({
            binding: bootstrap.preparation.viewer,
            run_id: bootstrap.run_id,
            staging_dir: record.staging_dir,
          });
          projectionObserver = startProductionViewerProjection({
            binding: bootstrap.preparation.viewer,
            execution: bootstrap.execution,
            journal_session: session,
            publish: projection.publish,
          });
        } catch (error) {
          projectionError = error instanceof Error ? error.message : String(error);
          writeComposedProgress(`Viewer projection unavailable: ${projectionError}`);
        }
      }
    }
    else writeComposedProgress(`Viewer unavailable: ${viewer.error}`);
  }
  writeComposedProgress("Starting world-first composed lifecycle");
  let outcome;
  try {
    const ports = createProductionComposedRunPorts({
      execution: bootstrap.execution, journal_session: session,
    });
    outcome = await runPreflightedComposedRun({
      configuration: composedRunConfiguration(bootstrap.execution),
      decision_inputs: { simfile: input.simfile },
      journal_path: bootstrap.journal_path,
      journal_session: session,
      ports: projectionObserver === undefined ? ports : {
        ...ports,
        world_finalization: bindTerminalViewerProjection(
          ports.world_finalization, projectionObserver,
        ),
      },
      request: bootstrap.request,
    });
  } catch (error) {
    await projectionObserver?.close();
    await record.abort();
    if (viewer?.state === "attached") await viewer.close();
    await revokeLinkedComposedSources(bootstrap);
    throw error;
  }
  const projectionObservation = await projectionObserver?.close();
  if (projectionObservation !== undefined) {
    writeComposedProgress(`Viewer projection: ${projectionObservation.published_snapshots} `
      + `authenticated snapshot(s), ${projectionObservation.failed_snapshots} rejected`);
    if (projectionObservation.published_snapshots === 0) {
      projectionError = projectionObservation.last_error
        ?? "no authenticated viewer projection was captured";
    }
  }
  if (outcome.receipt.status === "recovery_required") {
    await record.abort();
    if (viewer?.state === "attached") await viewer.close();
    process.stdout.write(serializeComposedReceipt(outcome.receipt));
    return recoveryExitCode(outcome.receipt.signal);
  }
  const completed = outcome as CompletedComposedRun;
  let revocationAttempted = false;
  try {
    writeComposedProgress("Reconciling and sealing exported evidence");
    if (projection !== undefined) {
      try {
        const captured = await projection.finalize(record);
        if (captured.publications === 0) {
          projectionError ??= "no authenticated viewer projection was captured";
        }
      } catch (error) {
        projectionError = error instanceof Error ? error.message : String(error);
        writeComposedProgress(`Viewer projection evidence unavailable: ${projectionError}`);
      }
    }
    const sealed = await sealLinkedComposedRecord({ bootstrap,
      lifecycle: completed, record });
    if (viewer?.state === "attached") {
      try {
        const seal = await viewer.awaitSeal();
        if (seal.status === "failed") {
          projectionError ??= seal.error ?? "viewer seal reconciliation failed";
        }
      } catch (error) {
        projectionError ??= error instanceof Error ? error.message : String(error);
      }
    }
    const replay = await replayComposedRunRecord({
      adapter: bootstrap.preparation.replay_adapter,
      run_dir: sealed.out_dir,
    });
    writeComposedProgress(`Exact replay verified at tick ${replay.terminal_tick}`);
    const liveEvidence = await deriveComposedLiveEvidence({
      accepted_actions_path: "actions/accepted.json",
      principals_path: "identity/principals.json",
      run_dir: sealed.out_dir,
    });
    revocationAttempted = true;
    await revokeLinkedComposedSources(bootstrap);
    const receipt = createComposedCommandReceipt({
      journal: completed.journal, lifecycle_receipt: completed.receipt,
      live_evidence: liveEvidence,
      manifest_digest: `sha256:${sealed.manifest_sha256}`,
      run_path: sealed.out_dir, viewer: receiptViewer(viewer, projectionError),
    });
    writeComposedFinalReceipt(receipt);
    return composedCommandExitCode(receipt);
  } finally {
    try {
      if (!revocationAttempted) await revokeLinkedComposedSources(bootstrap);
    } finally {
      if (viewer?.state === "attached") await viewer.close();
    }
  }
};
