import {
  composedCommandExitCode,
  createComposedCommandReceipt,
  createComposedLifecycleReplaySmokeReceipt,
  deriveComposedLiveEvidence,
  replayComposedRunRecord,
  verifyComposedTerminalOutcome,
  writeComposedFinalReceipt,
  writeComposedLifecycleReplaySmokeReceipt,
  writeComposedProgress,
  type CompletedComposedRun,
  type ComposedLiveViewerProjection,
  type ComposedRunRecord,
  type ComposedViewerAttachment,
} from "../compose/index.js";
import type { LinkedComposedBootstrap } from "./composedRunBootstrap.js";
import { revokeLinkedComposedSources } from "./composedRunBootstrap.js";
import { sealLinkedComposedRecord } from "./composedRunArtifacts.js";

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

export const finalizeLinkedComposedRun = async (input: Readonly<{
  bootstrap: LinkedComposedBootstrap;
  completed: CompletedComposedRun;
  projection?: ComposedLiveViewerProjection;
  projection_error?: string;
  record: ComposedRunRecord;
  viewer?: ComposedViewerAttachment;
}>): Promise<number> => {
  let projectionError = input.projection_error;
  let revocationAttempted = false;
  try {
    writeComposedProgress("Reconciling and sealing exported evidence");
    if (input.projection !== undefined) {
      try {
        const captured = await input.projection.finalize(input.record);
        if (captured.publications === 0) {
          projectionError ??= "no authenticated viewer projection was captured";
        }
      } catch (error) {
        projectionError = error instanceof Error ? error.message : String(error);
        writeComposedProgress(`Viewer projection evidence unavailable: ${projectionError}`);
      }
    }
    const sealed = await sealLinkedComposedRecord({ bootstrap: input.bootstrap,
      lifecycle: input.completed, record: input.record });
    if (input.viewer?.state === "attached") {
      try {
        const seal = await input.viewer.awaitSeal();
        if (seal.status === "failed") {
          projectionError ??= seal.error ?? "viewer seal reconciliation failed";
        }
      } catch (error) {
        projectionError ??= error instanceof Error ? error.message : String(error);
      }
    }
    const replay = await replayComposedRunRecord({
      adapter: input.bootstrap.preparation.replay_adapter,
      run_dir: sealed.out_dir,
    });
    verifyComposedTerminalOutcome(input.completed.journal, replay);
    writeComposedProgress(`Exact replay verified at tick ${replay.terminal_tick}`);
    if (input.bootstrap.command_mode === "lifecycle-replay-smoke") {
      revocationAttempted = true;
      await revokeLinkedComposedSources(input.bootstrap);
      writeComposedLifecycleReplaySmokeReceipt(createComposedLifecycleReplaySmokeReceipt({
        journal: input.completed.journal,
        lifecycle_receipt: input.completed.receipt,
        manifest_digest: `sha256:${sealed.manifest_sha256}`,
        replay, run_path: sealed.out_dir,
        viewer: receiptViewer(input.viewer, projectionError),
      }));
      return 0;
    }
    const liveEvidence = await deriveComposedLiveEvidence({
      accepted_actions_path: "actions/accepted.json",
      principals_path: "identity/principals.json",
      run_dir: sealed.out_dir,
    });
    revocationAttempted = true;
    await revokeLinkedComposedSources(input.bootstrap);
    const receipt = createComposedCommandReceipt({
      journal: input.completed.journal, lifecycle_receipt: input.completed.receipt,
      live_evidence: liveEvidence, manifest_digest: `sha256:${sealed.manifest_sha256}`,
      run_path: sealed.out_dir, viewer: receiptViewer(input.viewer, projectionError),
    });
    writeComposedFinalReceipt(receipt);
    return composedCommandExitCode(receipt);
  } finally {
    try {
      if (!revocationAttempted) await revokeLinkedComposedSources(input.bootstrap);
    } finally {
      if (input.viewer?.state === "attached") await input.viewer.close();
    }
  }
};
