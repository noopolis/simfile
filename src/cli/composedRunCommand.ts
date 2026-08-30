import {
  assertComposedDecisionInputs,
  attachComposedViewer,
  composedRunConfiguration,
  createComposedLiveViewerProjection,
  runPreflightedComposedRun,
  serializeComposedReceipt,
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
import {
  runComposedFailureCleanup,
  throwAfterComposedFailureCleanup,
} from "./composedFailureCleanup.js";
import { createLinkedComposedRecord } from
  "./composedRunArtifacts.js";
import { finalizeLinkedComposedRun } from "./composedRunCompletion.js";
import { removeComposedSupportRoot } from "./composedSupportRoot.js";
import { ComposedBootstrapRecoveryError } from "./composedBootstrapRecovery.js";
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
/** Owns the one production route into the generic composed lifecycle. */
export const runLinkedComposedCommand: LinkedComposedRunCommand = async (input) => {
  assertComposedDecisionInputs({ simfile: input.simfile });
  writeComposedProgress("Preparing linked composed run");
  let bootstrap;
  try { bootstrap = await prepareLinkedComposedRun(input); }
  catch (error) {
    if (!(error instanceof ComposedBootstrapRecoveryError)) throw error;
    process.stdout.write(serializeComposedReceipt(error.receipt));
    return recoveryExitCode(error.receipt.signal);
  }
  try {
  let record;
  try {
    record = await createLinkedComposedRecord(bootstrap);
  } catch (error) {
    return throwAfterComposedFailureCleanup(error, [{
      label: "credential source revocation",
      run: () => revokeLinkedComposedSources(bootstrap),
    }, {
      label: "private support-root removal",
      run: () => removeComposedSupportRoot(bootstrap.support_root),
    }]);
  }
  const session = bootstrap.journal_session;
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
      target_provider: bootstrap.target_provider,
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
    return throwAfterComposedFailureCleanup(error, [
      ...(projectionObserver === undefined ? [] : [{
        label: "viewer projection close", run: () => projectionObserver.close(),
      }]),
      { label: "staging record abort", run: () => record.abort() },
      ...(viewer?.state !== "attached" ? [] : [{
        label: "viewer close", run: () => viewer.close(),
      }]),
      { label: "credential source revocation", run: () => revokeLinkedComposedSources(bootstrap) },
    ]);
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
    const cleanupFailures = await runComposedFailureCleanup([
      { label: "staging record abort", run: () => record.abort() },
      ...(viewer?.state !== "attached" ? [] : [{
        label: "viewer close", run: () => viewer.close(),
      }]),
    ]);
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures,
        "composed recovery was preserved but local cleanup is incomplete");
    }
    process.stdout.write(serializeComposedReceipt(outcome.receipt));
    return recoveryExitCode(outcome.receipt.signal);
  }
  return await finalizeLinkedComposedRun({ bootstrap,
    completed: outcome as CompletedComposedRun, projection, projection_error: projectionError,
    record, viewer });
  } finally {
    bootstrap.target_provider.close();
  }
};
