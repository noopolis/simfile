import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import {
  composedOrganizationExportLifecycleInvocationId,
  composedRunIdSchema,
  createComposedRunRequestDigest,
  parseComposedExecution,
  parseComposedRunRequest,
  type ComposedExecution,
  type ComposedProjectBinding,
  type ComposedProjectPreparation,
  type ComposedRunRequest,
} from "../compose/index.js";
import { canonicalComposedJson, digestComposedJson } from "../compose/json.js";
import type { Simfile } from "../schema/index.js";
import {
  runSpawnfileCompile,
  runSpawnfileDeriveBundlePolicy,
  runSpawnfilePrepareContainerBundle,
  runSpawnfileProvisionCredentials,
  runSpawnfileRevokeCredentialSource,
  runSpawnfileSelectTarget,
  type SpawnfileCredentialProvisioningReceipt,
  type SpawnfileSelectedTarget,
} from "../spawnfile/bootstrapCli.js";
import { runSpawnfileConfigProducer } from "../spawnfile/process.js";
import { RUNNABLE_WORLD_SIDECAR_ARCHIVE_PATHS } from
  "../world-artifact/index.js";
import {
  compileReportMemberEngines,
  compileReportMoltnetReleaseExpectation,
  deriveCompiledOrganizationArtifactDigest,
  parseSpawnfileCompileReport,
} from "./compiledOrganizationIdentity.js";
import { projectCredentialBindingNames } from "./credentialBindingProjection.js";
import type { ParsedRunOptions } from "./runArguments.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);

const sha = (bytes: Uint8Array | string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const key = (domain: string, value: unknown): string =>
  digestComposedJson(domain, value).slice(7, 39);
export const composedOrganizationContainerName = (runId: string): string =>
  `simfile-org-${key("simfile.composed-container.v1", runId).slice(0, 16)}`;
export const composedDeploymentName = (runId: string): string =>
  `simfile-${key("simfile.composed-deployment.v1", runId).slice(0, 16)}`;
export const composedOrganizationUnitId = (runId: string): string =>
  `${composedDeploymentName(runId)}-container`;
export const composedHandoffRunEnvironment = (runId: string): Readonly<Record<string, string>> =>
  Object.freeze({ NOOPOLIS_RUN_ID: composedRunIdSchema.parse(runId) });
export const composedProviderLifecycleInvocations = (runId: string, requestDigest: string) =>
  Object.freeze({
    down: `lci_${key("simfile.composed-lifecycle.down.v1", runId)}`,
    export: composedOrganizationExportLifecycleInvocationId(requestDigest),
    up: `lci_${key("simfile.composed-lifecycle.up.v1", runId)}`,
  });
const environmentValue = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? undefined : value;
};
const executable = async (explicit?: string): Promise<string> => {
  const candidates = explicit === undefined
    ? (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
      .map((directory) => path.resolve(directory, "spawnfile"))
    : [path.resolve(explicit)];
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* continue */ }
  }
  throw new TypeError("Spawnfile executable is unavailable");
};
const writePrivateJson = async (target: string, value: unknown): Promise<void> => {
  await writeFile(target, canonicalComposedJson(value), { flag: "wx", mode: 0o600 });
};
const targetConfig = async (input: Readonly<{
  command: string;
  environment: NodeJS.ProcessEnv;
  selector: string;
  signal?: AbortSignal;
  workdir: string;
}>): Promise<Uint8Array> => runSpawnfileConfigProducer({
  args: [input.selector], command: input.command, cwd: input.workdir,
  env: input.environment, signal: input.signal,
});
const loadBinding = async (simfilePath: string, simfile: Simfile): Promise<ComposedProjectBinding> => {
  const reference = simfile.world_sidecar?.binding;
  if (reference === undefined) throw new TypeError("linked composed project has no binding");
  const modulePath = path.resolve(path.dirname(simfilePath), reference);
  const loaded = await import(pathToFileURL(modulePath).href) as Record<string, unknown>;
  const binding = loaded.composedProjectBinding as ComposedProjectBinding | undefined;
  if (binding?.version !== "simfile.composed-project-binding.v1"
    || typeof binding.prepareComposedProject !== "function") {
    throw new TypeError("linked composed project binding is invalid");
  }
  return binding;
};
export interface LinkedComposedBootstrap {
  readonly auth: SpawnfileCredentialProvisioningReceipt;
  readonly compile_fingerprint: string;
  readonly execution: ComposedExecution;
  readonly journal_path: string;
  readonly organization_evidence_directory: string;
  readonly preparation: ComposedProjectPreparation;
  readonly request: ComposedRunRequest;
  readonly run_id: string;
  readonly run_path: string;
  readonly source_handles: readonly string[];
  readonly support_root: string;
  readonly trusted_project_root: string;
  readonly world_evidence_directory: string;
}

const revokeCredentialSources = async (
  cli: Parameters<typeof runSpawnfileRevokeCredentialSource>[0],
  sources: readonly string[],
): Promise<void> => {
  const failures: unknown[] = [];
  for (const source_handle of sources) {
    try { await runSpawnfileRevokeCredentialSource(cli, { source_handle }); }
    catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw new AggregateError(
    failures, "composed credential source revocation is incomplete",
  );
};

export const revokeLinkedComposedSources = async (
  bootstrap: LinkedComposedBootstrap,
): Promise<void> => revokeCredentialSources({
  cwd: bootstrap.execution.provider.spawnfile_cwd,
  env: bootstrap.execution.provider.process_environment === undefined
    ? process.env : { ...process.env, ...bootstrap.execution.provider.process_environment },
  spawnfileBin: bootstrap.execution.provider.spawnfile_bin,
}, bootstrap.source_handles);

/** Resolves operator inputs and prepares only durable prerequisites through public Spawnfile CLIs. */
export const prepareLinkedComposedRun = async (input: Readonly<{
  linked_spawnfile_path: string;
  options: ParsedRunOptions;
  signal?: AbortSignal;
  simfile: Simfile;
  simfile_path: string;
  source_text: string;
}>): Promise<LinkedComposedBootstrap> => {
  const simfilePath = path.resolve(input.simfile_path);
  const spawnfilePath = path.resolve(input.linked_spawnfile_path);
  const seed = z.string().min(1).max(4_096).parse(
    input.options.seed ?? input.simfile.clock.seed,
  );
  const runId = composedRunIdSchema.parse(input.options.runId
    ?? (seed.replace(/[^A-Za-z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "") || "run"));
  const runPath = path.resolve(input.options.outDir ?? `runs/${runId}`);
  try {
    await lstat(runPath);
    throw new TypeError("composed output path already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const supportRoot = path.resolve(environmentValue("SIMFILE_COMPOSED_SUPPORT_ROOT")
    ?? path.join(path.dirname(runPath), ".simfile-composed", runId));
  await mkdir(path.dirname(supportRoot), { recursive: true, mode: 0o700 });
  await mkdir(supportRoot, { mode: 0o700 });
  const directories = Object.freeze({
    auth: path.join(supportRoot, "auth"), compiled: path.join(supportRoot, "compiled"),
    organizationEvidence: path.join(supportRoot, "evidence", "organization"),
    worldEvidenceArchive: path.join(supportRoot, "evidence", "world.tar"),
    worldEvidence: path.join(supportRoot, "evidence", "world"),
  });
  await Promise.all([mkdir(directories.auth, { mode: 0o700 }),
    mkdir(path.dirname(directories.organizationEvidence), { recursive: true, mode: 0o700 })]);
  const architectureInput = environmentValue("SPAWNFILE_MOLTNET_TARGET_ARCH") ?? "amd64";
  if (architectureInput !== "amd64" && architectureInput !== "arm64") {
    throw new TypeError("Spawnfile target architecture is invalid");
  }
  const architecture: "amd64" | "arm64" = architectureInput;
  const platform = { architecture, os: "linux" as const };
  const baseImageConfigDigest = digest.parse(
    environmentValue("SIMFILE_WORLD_BASE_IMAGE_CONFIG_DIGEST"),
  );
  const selector = identifier.parse(environmentValue("SPAWNFILE_TARGET_SELECTOR") ?? "gpu-4090");
  const authProfile = identifier.parse(environmentValue("SPAWNFILE_AUTH_PROFILE") ?? "simfile-live");
  const producer = environmentValue("SPAWNFILE_TARGET_CONFIG_PRODUCER")
    ?? "target-config-producer";
  const spawnfileBin = await executable(environmentValue("SPAWNFILE_BIN"));
  const projectRoot = path.dirname(simfilePath);
  const targetPlanPath = path.join(supportRoot, "target-plan.json");
  const processEnvironment: Record<string, string> = {
    ...composedHandoffRunEnvironment(runId),
    SIMFILE_COMPOSED_TARGET_PLAN: targetPlanPath,
    SPAWNFILE_HOME: directories.auth,
    SPAWNFILE_MOLTNET_TARGET_ARCH: architecture,
  };
  const releaseDirectory = environmentValue("SPAWNFILE_MOLTNET_RELEASE_DIR");
  if (releaseDirectory !== undefined) {
    processEnvironment.SPAWNFILE_MOLTNET_RELEASE_DIR = path.resolve(releaseDirectory);
  }
  const environment = { ...process.env, ...processEnvironment };
  const cli = { cwd: projectRoot, env: environment, spawnfileBin };
  const organizationContainer = composedOrganizationContainerName(runId);
  const binding = await loadBinding(simfilePath, input.simfile);
  const preparation = await binding.prepareComposedProject({
    base_image_config_digest: baseImageConfigDigest,
    evidence_root: "/var/lib/simfile/evidence", internal_port: 4070,
    organization_container_name: organizationContainer, platform, run_id: runId,
    secret_root: "/run/spawnfile-secrets", seed, simfile_path: simfilePath,
    spawnfile_path: spawnfilePath,
  });
  const bundle = preparation.bundle;
  const credentialProjection = projectCredentialBindingNames(preparation);
  const claims = {
    archiveDigest: bundle.archive_sha256,
    artifactDigest: bundle.manifest.artifact.service_digest,
    baseImageConfigDigest, bundleDigest: bundle.manifest.digest,
    entrypoint: bundle.manifest.entrypoint,
    launcherDigest: bundle.manifest.launcher.sha256,
    networkAlias: bundle.manifest.network.dns_alias, platform,
  };
  const policy = await runSpawnfileDeriveBundlePolicy(cli, claims, input.signal);
  let config = await targetConfig({ command: producer, environment, selector,
    signal: input.signal, workdir: projectRoot });
  let selected: SpawnfileSelectedTarget;
  try {
    selected = await runSpawnfileSelectTarget(cli, { request: {
      idempotency_key: `idem_${key("simfile.composed-select-target.v1", { runId, selector })}`,
      operation: "select_target", target_reference: selector,
      version: "spawnfile.target-resource.request.v1",
    }, signal: input.signal, target_config_stdin: config });
  } finally { config.fill(0); }
  await writePrivateJson(targetPlanPath, {
    evidence_destination: directories.worldEvidenceArchive,
    prepared_artifact_mapping: {
      archive_digest: bundle.archive_sha256,
      artifact_manifest_digest: bundle.manifest.artifact.service_digest,
      base_image_config_digest: baseImageConfigDigest,
      build_policy_digest: policy.build_policy_digest,
      bundle_digest: bundle.manifest.digest, entrypoint: bundle.manifest.entrypoint,
      launcher_digest: bundle.manifest.launcher.sha256,
      network_alias: bundle.manifest.network.dns_alias, platform,
      platform_digest: policy.platform_digest,
    },
    run_id: runId, target_selector: selector,
    version: "simfile.composed-target-plan.v1",
  });
  const bundleRequest = {
    archive_base64: Buffer.from(bundle.archive_bytes).toString("base64"),
    archive_digest: bundle.archive_sha256,
    archive_entries: RUNNABLE_WORLD_SIDECAR_ARCHIVE_PATHS,
    artifact_digest: bundle.manifest.artifact.service_digest,
    build_policy_digest: policy.build_policy_digest,
    bundle_digest: bundle.manifest.digest, entrypoint: bundle.manifest.entrypoint,
    idempotency_key: `idem_${key("simfile.composed-prepare-bundle.v1", {
      archive: bundle.archive_sha256, selected,
    })}`,
    launcher_digest: bundle.manifest.launcher.sha256,
    network_alias: bundle.manifest.network.dns_alias, platform,
    platform_digest: policy.platform_digest,
    selected_target: { fingerprint: selected.fingerprint, handle: selected.handle },
    version: "spawnfile.target-local-container-bundle.prepare-request.v1",
  } as const;
  config = await targetConfig({ command: producer, environment, selector,
    signal: input.signal, workdir: projectRoot });
  try {
    await runSpawnfilePrepareContainerBundle(cli, { request: bundleRequest,
      signal: input.signal, target_config_stdin: config });
  } finally { config.fill(0); }
  const report = parseSpawnfileCompileReport(await runSpawnfileCompile(cli, {
    compiled_output_directory: directories.compiled,
    organization_path: spawnfilePath, signal: input.signal,
  }));
  if (report.container.moltnet.release.architecture !== architecture) {
    throw new TypeError("Spawnfile Moltnet release architecture drift");
  }
  const selectedReceipt = { ...selected,
    version: "spawnfile.target-resource.selected-target.v1" as const };
  const selectedFile = path.join(supportRoot, "selected-target.json");
  await writePrivateJson(selectedFile, selectedReceipt);
  const selectedDigest = sha(canonicalComposedJson(selectedReceipt));
  const organizationArtifactDigest = deriveCompiledOrganizationArtifactDigest(
    report.compile_fingerprint,
  );
  const simfileDigest = sha(input.source_text);
  const spawnfileDigest = sha(await readFile(spawnfilePath));
  const descriptorDigest = digestComposedJson("simfile.composed-project-descriptor.v1", {
    organization: report.compile_fingerprint, simfile: simfileDigest,
    spawnfile: spawnfileDigest, world: bundle.manifest.digest,
  });
  const envFile = path.join(supportRoot, "organization.env");
  const bindingsFile = path.join(supportRoot, "world-bindings.json");
  const grantsFile = path.join(supportRoot, "resolved-world-grants.json");
  await writePrivateJson(grantsFile, {
    grants: preparation.world_members.map((member) => ({
      capability_manifest: member.capability_manifest,
      member_id: member.id, principal_id: member.principal_id,
    })),
    run_id: runId, version: "spawnfile.auth.resolved-world-grants.v1",
    world_instance_id: preparation.readiness_expectation.world_instance_id,
  });
  const auth = await runSpawnfileProvisionCredentials(cli, {
    env_file: envFile,
    request: {
      credentials: credentialProjection.credentials, descriptor_digest: descriptorDigest,
      model_engine_auth: { kind: "codex", profile: authProfile },
      run_id: runId, scope: "world", selected_target: selectedReceipt,
      version: "spawnfile.auth.credential-provisioning.request.v1",
      world_bindings: {
        json_url: `http://${bundle.manifest.network.dns_alias}:${bundle.manifest.network.internal_port}/v1/world`,
        mcp_url: `http://${bundle.manifest.network.dns_alias}:${bundle.manifest.network.internal_port}/mcp`,
        members: credentialProjection.world_members.map(({ id, principal_id, token_credential_name }) =>
          ({ id, principal_id, token_credential_name })),
        world_instance_id: preparation.readiness_expectation.world_instance_id,
      },
    },
    resolved_grants_file: grantsFile, signal: input.signal,
    world_bindings_file: bindingsFile,
  });
  const sourceHandles = Object.freeze(auth.credentials.map(({ source_handle }) => source_handle));
  try {
    const worldBindingsDigest = digest.parse(auth.world_bindings_digest);
    const sourceByName = new Map(auth.credentials.map(({ name, source_handle }) =>
      [name, source_handle]));
    const request = parseComposedRunRequest({
      descriptor_digest: descriptorDigest, mode: "live",
      organization: { artifact_digest: organizationArtifactDigest,
        source_digest: spawnfileDigest, world_bindings_digest: worldBindingsDigest },
      required_world_capabilities: ["simfile.world-decision-claim.v1"],
      run_id: runId, source_digest: simfileDigest,
      target: { auth_profile: authProfile, selector },
      version: "simfile.composed-run-request.v1",
      world: { artifact_manifest_digest: bundle.manifest.artifact.service_digest,
        bundle_digest: bundle.manifest.digest,
        runtime_abi: "simfile.world-sidecar-runtime.v1" },
    });
    const requestDigest = createComposedRunRequestDigest(request);
    const execution = parseComposedExecution({
    configuration: {
      organization_expectation: {
        deployment_name: composedDeploymentName(runId),
        member_engines: compileReportMemberEngines(report),
        moltnet_release: compileReportMoltnetReleaseExpectation(report),
        selected_target_receipt_digest: selectedDigest,
        unit_id: composedOrganizationUnitId(runId),
        world_binding_digest: worldBindingsDigest,
      },
      readiness_expectation: preparation.readiness_expectation,
      terminal_tick: preparation.terminal_tick,
      topology_expectation: { selected_target: {
        fingerprint: selected.fingerprint, handle: selected.handle,
      } },
    },
    provider: {
      compiled_output_directory: directories.compiled,
      evidence_destination_directory: directories.organizationEvidence,
      evidence_mount_path: "/var/lib/simfile/evidence",
      lifecycle_invocations: composedProviderLifecycleInvocations(runId, requestDigest),
      organization_handoff: { env_file: envFile,
        selected_target_receipt_file: selectedFile, world_bindings_file: bindingsFile },
      organization_container_name: organizationContainer,
      organization_image_tag: `simfile-org-${key("simfile.composed-image.v1", runId).slice(0, 16)}:run`,
      organization_path: spawnfilePath, process_environment: processEnvironment,
      spawnfile_bin: spawnfileBin, spawnfile_cwd: projectRoot,
      target_config_producer: { args: [selector], command: producer,
        transport: "stdout_to_spawnfile_stdin" },
      terminal_artifact: { id: "composed_terminal", max_bytes: 131_072,
        path: "/tmp/spawnfile-public/composed-terminal.json" },
      world_evidence_export: {
        archive_path: directories.worldEvidenceArchive,
        destination_directory: directories.worldEvidence,
      },
      world_readiness_port: bundle.manifest.network.internal_port,
    },
    secret_bindings: credentialProjection.secret_bindings.map((binding) => ({
      name: binding.name, scope: binding.scope,
      source_handle: z.string().parse(sourceByName.get(binding.credential_name)),
    })),
    version: "simfile.composed-execution.v1",
  });
    return Object.freeze({ auth, compile_fingerprint: report.compile_fingerprint, execution,
      journal_path: path.join(supportRoot, "journal", "phase-journal.json"),
      organization_evidence_directory: directories.organizationEvidence,
      preparation, request, run_id: runId, run_path: runPath,
      source_handles: sourceHandles, support_root: supportRoot,
      trusted_project_root: projectRoot,
      world_evidence_directory: directories.worldEvidence });
  } catch (error) {
    try { await revokeCredentialSources(cli, sourceHandles); }
    catch (revocationError) {
      throw new AggregateError([error, revocationError],
        "composed bootstrap failed and credential revocation is incomplete");
    }
    throw error;
  }
};
