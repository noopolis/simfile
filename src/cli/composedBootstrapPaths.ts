import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";

import type { ComposedCommandMode } from "./runArguments.js";

export interface ComposedBootstrapPaths {
  readonly auth: string;
  readonly compiled: string;
  readonly env_file: string;
  readonly grants_file: string;
  readonly journal: string;
  readonly organization_evidence: string;
  readonly preflight_report: string;
  readonly prepared_plan: string;
  readonly run: string;
  readonly selected_target_file: string;
  readonly support_root: string;
  readonly world_bindings_file: string;
  readonly world_evidence: string;
  readonly world_evidence_archive: string;
}

const environmentValue = (
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined => {
  const value = environment[name];
  return value === undefined || value.length === 0 ? undefined : value;
};

export const bootstrapOption = environmentValue;

export const resolveComposedRunIdentity = (input: Readonly<{
  out_dir?: string;
  run_id: string;
}>): Readonly<{ run_id: string; run_path: string }> => Object.freeze({
  run_id: input.run_id,
  run_path: path.resolve(input.out_dir ?? `runs/${input.run_id}`),
});

export const assertComposedRunPathAvailable = async (runPath: string): Promise<void> => {
  try {
    await lstat(runPath);
    throw new TypeError("composed output path already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

export const createComposedBootstrapPaths = (input: Readonly<{
  environment: NodeJS.ProcessEnv;
  run_id: string;
  run_path: string;
}>): ComposedBootstrapPaths => {
  const supportRoot = path.resolve(environmentValue(
    input.environment, "SIMFILE_COMPOSED_SUPPORT_ROOT",
  ) ?? path.join(path.dirname(input.run_path), ".simfile-composed", input.run_id));
  return Object.freeze({
    auth: path.join(supportRoot, "auth"),
    compiled: path.join(supportRoot, "compiled"),
    env_file: path.join(supportRoot, "organization.env"),
    grants_file: path.join(supportRoot, "resolved-world-grants.json"),
    journal: path.join(supportRoot, "journal", "phase-journal.json"),
    organization_evidence: path.join(supportRoot, "evidence", "organization"),
    preflight_report: path.join(supportRoot, "preflight-compile-report.json"),
    prepared_plan: path.join(supportRoot, "target-plan.json"),
    run: input.run_path,
    selected_target_file: path.join(supportRoot, "selected-target.json"),
    support_root: supportRoot,
    world_bindings_file: path.join(supportRoot, "world-bindings.json"),
    world_evidence: path.join(supportRoot, "evidence", "world"),
    world_evidence_archive: path.join(supportRoot, "evidence", "world.tar"),
  });
};

export const createComposedBootstrapDirectories = async (
  paths: ComposedBootstrapPaths,
): Promise<void> => {
  await Promise.all([
    mkdir(paths.auth, { recursive: true, mode: 0o700 }),
    mkdir(path.dirname(paths.journal), { recursive: true, mode: 0o700 }),
    mkdir(path.dirname(paths.organization_evidence), { recursive: true, mode: 0o700 }),
  ]);
};

export const composedCommandMode = (
  value: ComposedCommandMode | undefined,
): ComposedCommandMode => value ?? "live";
