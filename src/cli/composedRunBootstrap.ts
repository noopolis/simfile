import path from "node:path";

import { z } from "zod";

import { composedRunIdSchema } from "../compose/index.js";
import type { Simfile } from "../schema/index.js";
import { runSpawnfileRevokeCredentialSource } from "../spawnfile/bootstrapCli.js";
import { finalizeComposedBootstrap } from "./composedBootstrapFinalize.js";
import { prepareLocalComposedBootstrap } from "./composedBootstrapLocal.js";
import {
  assertComposedRunPathAvailable,
  composedCommandMode,
  createComposedBootstrapPaths,
  resolveComposedRunIdentity,
} from "./composedBootstrapPaths.js";
import { preserveComposedBootstrapFailure } from "./composedBootstrapRecovery.js";
import type { LinkedComposedBootstrap } from "./composedBootstrapState.js";
import { withComposedSupportRoot } from "./composedSupportRoot.js";
import { admitComposedSpawnfile } from "./composedSpawnfileAdmission.js";
import type { ParsedRunOptions } from "./runArguments.js";

export {
  composedDeploymentName,
  composedHandoffRunEnvironment,
  composedOrganizationContainerName,
  composedOrganizationUnitId,
  composedProviderLifecycleInvocations,
} from "./composedBootstrapContract.js";
export type { LinkedComposedBootstrap } from "./composedBootstrapState.js";

const revokeCredentialSources = async (
  bootstrap: LinkedComposedBootstrap,
): Promise<void> => {
  const failures: unknown[] = [];
  const provider = bootstrap.execution.provider;
  const context = {
    bootstrapLocalExecutableIdentity: {
      path: provider.spawnfile_bin,
      sha256: provider.spawnfile_executable_sha256 as `sha256:${string}`,
    },
    cwd: provider.spawnfile_cwd,
    env: provider.process_environment === undefined
      ? process.env : { ...process.env, ...provider.process_environment },
    spawnfileBin: provider.spawnfile_bin,
  };
  for (const source_handle of bootstrap.source_handles) {
    try { await runSpawnfileRevokeCredentialSource(context, { source_handle }); }
    catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw new AggregateError(
    failures, "composed credential source revocation is incomplete",
  );
};

export const revokeLinkedComposedSources = revokeCredentialSources;

/** Creates durable bootstrap authority before any target/helper/auth mutation. */
export const prepareLinkedComposedRun = async (input: Readonly<{
  environment?: NodeJS.ProcessEnv;
  linked_spawnfile_path: string;
  options: ParsedRunOptions;
  signal?: AbortSignal;
  simfile: Simfile;
  simfile_path: string;
  source_text: string;
}>, _legacyDependencies?: unknown): Promise<LinkedComposedBootstrap> => {
  const seed = z.string().min(1).max(4_096).parse(
    input.options.seed ?? input.simfile.clock.seed,
  );
  const normalized = seed.replace(/[^A-Za-z0-9_.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const runId = composedRunIdSchema.parse(input.options.runId ?? (normalized || "run"));
  const identity = resolveComposedRunIdentity({ out_dir: input.options.outDir, run_id: runId });
  await assertComposedRunPathAvailable(identity.run_path);
  const environment = input.environment ?? process.env;
  const paths = createComposedBootstrapPaths({ environment,
    run_id: runId, run_path: identity.run_path });
  const simfilePath = path.resolve(input.simfile_path);
  const spawnfilePath = path.resolve(input.linked_spawnfile_path);
  if (input.options.targetContext === undefined) {
    throw new TypeError("linked composed run requires --context");
  }
  const targetContext = input.options.targetContext;
  const admitted = await admitComposedSpawnfile({ environment,
    project_root: path.dirname(simfilePath), run_id: runId,
    signal: input.signal, spawnfile_home: paths.auth });
  const state = await withComposedSupportRoot(paths.support_root, async () =>
    prepareLocalComposedBootstrap({
      admitted,
      command_mode: composedCommandMode(input.options.composedMode),
      environment,
      paths,
      run_id: runId,
      seed,
      signal: input.signal,
      simfile: input.simfile,
      simfile_path: simfilePath,
      source_text: input.source_text,
      spawnfile_path: spawnfilePath,
      target_context: targetContext,
    }));
  try {
    return await finalizeComposedBootstrap(state, input.signal);
  } catch (error) {
    let recovery: Error;
    try { recovery = await preserveComposedBootstrapFailure(state.journal_session, error); }
    catch (preservationError) {
      throw new AggregateError([error, preservationError],
        "composed bootstrap failed and recovery state could not be preserved");
    }
    throw recovery;
  }
};
