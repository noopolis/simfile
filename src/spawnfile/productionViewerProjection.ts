import { createHash } from "node:crypto";

import type { ComposedExecution } from "../compose/execution.js";
import type { ComposedWorldFinalizationPort } from "../compose/finalize-world.js";
import type { ComposedPhaseJournal } from "../compose/journal.js";
import { digestComposedJson } from "../compose/json.js";
import type { ComposedJournalSession } from "../compose/journalSession.js";
import { parseComposedWorldServiceReceipt } from "../compose/startup-world.js";
import type { ComposedViewerBinding } from "../compose/viewerBinding.js";
import type { VerifiedViewerProjectionSource } from
  "../compose/liveViewerProjection.js";
import { createProductionTargetDriver } from "./productionTarget.js";
import { readTargetPublicBytes } from "./targetReceipts.js";

interface SelectedTarget {
  readonly fingerprint: string;
  readonly handle: string;
}

interface ProjectionTargetDriver {
  load(): Promise<ComposedPhaseJournal>;
  runTarget(command: string, request: Readonly<Record<string, unknown>>,
    signal: AbortSignal): Promise<unknown>;
  readonly selectedTarget: SelectedTarget;
}

export interface ProductionViewerProjectionObserver {
  captureTerminal(): Promise<void>;
  close(): Promise<Readonly<{
    failed_snapshots: number;
    last_error?: string;
    published_snapshots: number;
  }>>;
}

export interface ProductionViewerProjectionDependencies {
  readonly createDriver?: (input: Readonly<{
    execution: ComposedExecution;
    journal_session: ComposedJournalSession;
  }>) => ProjectionTargetDriver;
  readonly poll_ms?: number;
}

const waitForPoll = (signal: AbortSignal, milliseconds: number): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(done, milliseconds);
    function done(): void { signal.removeEventListener("abort", aborted); resolve(); }
    function aborted(): void {
      clearTimeout(timer); signal.removeEventListener("abort", aborted); reject(signal.reason);
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const startedService = (journal: ComposedPhaseJournal) => {
  const entry = journal.entries.find(({ phase }) => phase === "world_started_paused");
  if (entry === undefined) return undefined;
  return parseComposedWorldServiceReceipt(entry.payload.receipt);
};

/** Starts a cancellable read-only poller for one declared public viewer artifact. */
export const startProductionViewerProjection = (input: Readonly<{
  binding: ComposedViewerBinding;
  dependencies?: ProductionViewerProjectionDependencies;
  execution: ComposedExecution;
  journal_session: ComposedJournalSession;
  publish(bytes: Uint8Array, source: VerifiedViewerProjectionSource): Promise<void>;
}>): ProductionViewerProjectionObserver => {
  const live = input.binding.live_trace;
  if (live === undefined) throw new TypeError("composed live viewer binding is absent");
  const driver = input.dependencies?.createDriver?.({
    execution: input.execution,
    journal_session: input.journal_session,
  }) ?? createProductionTargetDriver({
    execution: input.execution,
    journal_session: input.journal_session,
  });
  const controller = new AbortController();
  const pollMs = input.dependencies?.poll_ms ?? 750;
  if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 60_000) {
    throw new TypeError("composed viewer projection poll interval is invalid");
  }
  let failed = 0;
  let published = 0;
  let lastError: string | undefined;
  let lastDigest: string | undefined;

  const capture = async (signal: AbortSignal): Promise<boolean> => {
    const journal = await driver.load();
    const paused = journal.entries.some(({ phase }) => phase === "world_paused");
    const service = startedService(journal);
    if (service === undefined) return paused;
    const request = {
      artifact: live.artifact,
      descriptor_digest: journal.request.descriptor_digest,
      run_id: journal.request.run_id,
      selected_target: driver.selectedTarget,
      version: "spawnfile.target-public-artifact-snapshot.request.v1",
      world_service_handle: service.service_handle,
    } as const;
    const raw = await driver.runTarget("snapshot_public_artifact", request, signal);
    const bytes = readTargetPublicBytes({
      artifact_id: live.artifact.id, raw, request,
    });
    try {
      const contentDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (contentDigest !== lastDigest) {
        await input.publish(bytes, {
          artifact_id: live.artifact.id,
          content_digest: contentDigest,
          media_type: live.artifact.media_type,
          request,
          request_digest: digestComposedJson(
            "spawnfile.target-public-artifact-snapshot.request.v1", request,
          ),
          response_version: "spawnfile.target-public-artifact-snapshot.v1",
          run_id: journal.request.run_id,
          size_bytes: bytes.byteLength,
        });
        lastDigest = contentDigest;
        published += 1;
      }
    } finally {
      bytes.fill(0);
    }
    return paused;
  };

  const task = (async (): Promise<void> => {
    while (!controller.signal.aborted) {
      try {
        if (await capture(controller.signal)) break;
      } catch (error) {
        if (controller.signal.aborted) break;
        failed += 1;
        lastError = message(error);
      }
      try {
        await waitForPoll(controller.signal, pollMs);
      } catch {
        break;
      }
    }
  })();
  let terminalCapture: Promise<void> | undefined;

  const captureTerminal = (): Promise<void> => {
    terminalCapture ??= (async () => {
      try {
        controller.abort(new Error("composed viewer projection reached terminal phase"));
        await task;
        // The terminal receipt is durable and the world still exists. The
        // bound finalization port invokes this before its destructive pause.
        await capture(AbortSignal.timeout(5_000));
      } catch (error) {
        failed += 1;
        lastError = message(error);
      }
    })();
    return terminalCapture;
  };

  return Object.freeze({
    captureTerminal,
    close: async () => {
      controller.abort(new Error("composed viewer projection closed"));
      await task;
      await terminalCapture;
      return Object.freeze({
        failed_snapshots: failed,
        ...(lastError === undefined ? {} : { last_error: lastError }),
        published_snapshots: published,
      });
    },
  });
};

/** Inserts the terminal read after durable terminal and before destructive pause. */
export const bindTerminalViewerProjection = (
  port: ComposedWorldFinalizationPort,
  observer: ProductionViewerProjectionObserver,
): ComposedWorldFinalizationPort => Object.freeze({
  exportWorldEvidence: (
    input: Parameters<ComposedWorldFinalizationPort["exportWorldEvidence"]>[0],
  ) => port.exportWorldEvidence(input),
  pauseWorld: async (
    input: Parameters<ComposedWorldFinalizationPort["pauseWorld"]>[0],
  ) => {
    try { await observer.captureTerminal(); } catch { /* observer only */ }
    return port.pauseWorld(input);
  },
});
