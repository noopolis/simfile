import { createViewerServer, type ViewerServerHandle } from "../view/server.js";
import type { RunSealFollowerState } from "../view/runSealFollower.js";
import { loadRunViewerExtensionPlan } from "../view/runViewerExtensions.js";

export type ComposedViewerAttachment = Readonly<
  | { awaitSeal: () => Promise<RunSealFollowerState>;
    close: () => Promise<void>; state: "attached"; url: string }
  | { error: string; state: "unavailable" }
>;

export interface ComposedViewerDependencies {
  readonly createServer?: typeof createViewerServer;
  readonly loadExtensionPlan?: typeof loadRunViewerExtensionPlan;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Attaches one observer to a run-output path. Failure is returned as evidence;
 * it never enters the composed lifecycle or world-service control ports.
 */
export const attachComposedViewer = async (input: Readonly<{
  run_dir: string;
  trusted_project_root: string;
  dependencies?: ComposedViewerDependencies;
}>): Promise<ComposedViewerAttachment> => {
  const loadExtensionPlan = input.dependencies?.loadExtensionPlan
    ?? loadRunViewerExtensionPlan;
  const createServer = input.dependencies?.createServer ?? createViewerServer;
  let handle: ViewerServerHandle | undefined;
  try {
    const plan = await loadExtensionPlan({
      explicitDescriptors: [], ignoreRecorded: false,
      runDir: input.run_dir, trustedRoot: input.trusted_project_root,
    });
    handle = await createServer({
      extensionIdentities: plan.identities,
      extensions: plan.mounts,
      mode: "replay",
      port: 0,
      reconcileViewerExtensionsAtSeal: plan.reconcileAtSeal,
      sourcePath: input.run_dir,
    });
    return Object.freeze({
      awaitSeal: () => handle!.awaitSeal(),
      close: async () => { try { await handle?.close(); } catch { /* observer only */ } },
      state: "attached" as const,
      url: handle.url,
    });
  } catch (error) {
    if (handle !== undefined) {
      try { await handle.close(); } catch { /* observer only */ }
    }
    return Object.freeze({ error: message(error), state: "unavailable" as const });
  }
};
