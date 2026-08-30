import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import {
  canonicalComposedJson,
} from "../compose/json.js";
import type { ComposedBootstrapCapsule, ComposedJournalSession } from "../compose/index.js";
import { parseSimfileSource } from "../schema/index.js";
import { runSpawnfileDeriveBundlePolicy } from "../spawnfile/containerBundleCli.js";
import { resolveSpawnfileOrganizationAuthentication } from
  "../spawnfile/organizationAuthentication.js";
import {
  COMPOSED_SPAWNFILE_OPERATION_TIMEOUT_MS,
  type BootstrapSpawnfileCliContext,
} from "../spawnfile/process.js";
import { runSpawnfileTargetConfigPreview } from "../spawnfile/targetConfigPreview.js";
import {
  loadComposedProjectBinding,
  readLinkedSpawnfileSource,
} from "./composedProjectPreflight.js";
import {
  compileReportMemberEngines,
} from "./compiledOrganizationIdentity.js";
import { composedIdempotencyKey, composedOrganizationContainerName } from
  "./composedBootstrapContract.js";
import type { ComposedBootstrapPaths } from "./composedBootstrapPaths.js";
import type { PreparedComposedBootstrap } from "./composedBootstrapState.js";
import { revalidateComposedSpawnfile } from "./composedSpawnfileAdmission.js";
import { describeComposedProject } from "./composedProjectDescriptor.js";
import {
  assertRecoverySourceDigests,
  readPreflightCompileReport,
} from "./composedPreflightReport.js";

const child = (root: string, candidate: string): boolean =>
  candidate.startsWith(`${root}${path.sep}`);

const capsulePaths = (capsule: ComposedBootstrapCapsule): ComposedBootstrapPaths => {
  const values = capsule.paths;
  for (const [name, value] of Object.entries(values)) {
    if (["organization_path", "run", "simfile", "support_root"].includes(name)) continue;
    if (!child(values.support_root, value)) {
      throw new TypeError("composed bootstrap capsule path escaped its private root");
    }
  }
  return Object.freeze({ auth: capsule.provider.process_environment.SPAWNFILE_HOME!,
    compiled: values.compiled, env_file: values.env_file, grants_file: values.grants_file,
    journal: values.journal, organization_evidence: values.organization_evidence,
    preflight_report: values.preflight_report, prepared_plan: values.prepared_plan, run: values.run,
    selected_target_file: values.selected_target_file, support_root: values.support_root,
    world_bindings_file: values.world_bindings_file,
    world_evidence: values.world_evidence,
    world_evidence_archive: values.world_evidence_archive });
};

export const reconstructComposedBootstrap = async (input: Readonly<{
  capsule: ComposedBootstrapCapsule;
  journal_session: ComposedJournalSession;
  signal?: AbortSignal;
}>): Promise<PreparedComposedBootstrap> => {
  const capsule = input.capsule;
  const paths = capsulePaths(capsule);
  if (paths.journal !== input.journal_session.path
    || capsule.provider.spawnfile_cwd !== path.dirname(capsule.paths.simfile)
    || capsule.provider.process_environment.NOOPOLIS_RUN_ID !== capsule.run_id
    || capsule.provider.process_environment.SPAWNFILE_HOME !== paths.auth) {
    throw new TypeError("composed bootstrap capsule identity is contradictory");
  }
  const support = await lstat(paths.support_root);
  if (!support.isDirectory() || support.isSymbolicLink()
    || process.getuid?.() !== undefined && support.uid !== process.getuid!()
    || process.platform !== "win32" && (support.mode & 0o777) !== 0o700) {
    throw new TypeError("composed bootstrap support root changed");
  }
  const identity = { path: capsule.provider.spawnfile_bin,
    sha256: capsule.provider.spawnfile_executable_sha256 as `sha256:${string}` };
  const cli: BootstrapSpawnfileCliContext = {
    bootstrapLocalExecutableIdentity: identity,
    cwd: capsule.provider.spawnfile_cwd,
    env: { ...process.env, ...capsule.provider.process_environment },
    spawnfileBin: capsule.provider.spawnfile_bin,
    timeoutMs: COMPOSED_SPAWNFILE_OPERATION_TIMEOUT_MS,
  };
  await revalidateComposedSpawnfile({
    capability_contract_digest: capsule.provider.capability_contract_digest,
    context: cli,
    signal: input.signal,
  });
  const sourceText = await readFile(capsule.paths.simfile, "utf8");
  const parsed = parseSimfileSource(sourceText, { path: capsule.paths.simfile });
  const spawnfileSource = await readLinkedSpawnfileSource(capsule.paths.organization_path);
  assertRecoverySourceDigests({
    expected_simfile_digest: capsule.project.simfile_source_digest,
    expected_spawnfile_digest: capsule.project.spawnfile_source_digest,
    simfile_source: sourceText,
    spawnfile_source: spawnfileSource.bytes,
  });
  const target = await runSpawnfileTargetConfigPreview({
    base_image: capsule.provider.base_image,
    context: cli,
    docker_command: capsule.provider.docker_command,
    evidence_destination: paths.world_evidence_archive,
    local_context: capsule.provider.context,
    signal: input.signal,
  });
  const binding = await loadComposedProjectBinding(capsule.paths.simfile, parsed.simfile);
  const preparation = await binding.prepareComposedProject({
    base_image_config_digest: target.base_image.config_digest,
    evidence_root: "/var/lib/simfile/evidence",
    internal_port: 4070,
    organization_container_name: composedOrganizationContainerName(capsule.run_id),
    platform: target.platform,
    run_id: capsule.run_id,
    secret_root: "/run/spawnfile-secrets",
    seed: capsule.project.seed,
    simfile_path: capsule.paths.simfile,
    spawnfile_path: capsule.paths.organization_path,
  });
  const bundle = preparation.bundle;
  const claims = { archiveDigest: bundle.archive_sha256,
    artifactDigest: bundle.manifest.artifact.service_digest,
    baseImageConfigDigest: target.base_image.config_digest,
    bundleDigest: bundle.manifest.digest, entrypoint: bundle.manifest.entrypoint,
    launcherDigest: bundle.manifest.launcher.sha256,
    networkAlias: bundle.manifest.network.dns_alias, platform: target.platform };
  const policy = await runSpawnfileDeriveBundlePolicy(cli, claims, input.signal);
  const mapping = { archive_digest: bundle.archive_sha256,
    artifact_manifest_digest: bundle.manifest.artifact.service_digest,
    base_image_config_digest: target.base_image.config_digest,
    build_policy_digest: policy.build_policy_digest, bundle_digest: bundle.manifest.digest,
    entrypoint: bundle.manifest.entrypoint, launcher_digest: bundle.manifest.launcher.sha256,
    network_alias: bundle.manifest.network.dns_alias, platform: target.platform,
    platform_digest: policy.platform_digest };
  const expectedPlan = { evidence_destination: paths.world_evidence_archive,
    prepared_artifact_mapping: mapping,
    version: "spawnfile.target-config-prepared-plan.v1" };
  if (canonicalComposedJson(JSON.parse(await readFile(paths.prepared_plan, "utf8")))
    !== canonicalComposedJson(expectedPlan)) {
    throw new TypeError("composed prepared target plan changed");
  }
  const report = await readPreflightCompileReport(
    paths.preflight_report, capsule.project.preflight_report_digest,
  );
  const authentication = resolveSpawnfileOrganizationAuthentication({
    configured_auth_profile: input.journal_session.current().request.target.auth_profile,
    member_engines: compileReportMemberEngines(report),
  });
  const project = describeComposedProject({
    authentication_profile: authentication.correlation_auth_profile,
    build_policy_digest: policy.build_policy_digest,
    compile_fingerprint: report.compile_fingerprint,
    platform_digest: policy.platform_digest, preparation, run_id: capsule.run_id,
    selected_context: capsule.provider.context, simfile_source: sourceText,
    spawnfile_source: spawnfileSource.bytes, target,
  });
  const journal = input.journal_session.current();
  if (canonicalComposedJson(project.request) !== canonicalComposedJson(journal.request)
    || report.compile_fingerprint !== capsule.project.compile_fingerprint
    || project.descriptor_digest !== capsule.project.descriptor_digest
    || project.simfile_source_digest !== capsule.project.simfile_source_digest
    || project.spawnfile_source_digest !== capsule.project.spawnfile_source_digest) {
    throw new TypeError("composed bootstrap project identity changed");
  }
  return Object.freeze({ authentication, base_image: capsule.provider.base_image,
    bundle_request_base: project.bundle_request_base, capsule, cli,
    command_mode: capsule.command_mode, credential_projection: project.credential_projection,
    docker_command: capsule.provider.docker_command,
    journal_session: input.journal_session, paths, preparation, report,
    request: project.request, selected_request: Object.freeze({ idempotency_key:
      composedIdempotencyKey("simfile.composed-select-target.v1", {
        context: capsule.provider.context, run_id: capsule.run_id }),
      operation: "select_target", target_reference: capsule.provider.context,
      version: "spawnfile.target-resource.request.v1" }) });
};
