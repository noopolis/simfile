import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  createBootstrapComposedPhaseJournal,
  createComposedJournalSession,
  parseComposedBootstrapCapsule,
} from "../compose/index.js";
import type { Simfile } from "../schema/index.js";
import { runSpawnfileCompile } from "../spawnfile/bootstrapCli.js";
import { runSpawnfileDeriveBundlePolicy } from "../spawnfile/containerBundleCli.js";
import { resolveSpawnfileOrganizationAuthentication } from
  "../spawnfile/organizationAuthentication.js";
import { runSpawnfileTargetConfigPreview } from "../spawnfile/targetConfigPreview.js";
import {
  assertLinkedSpawnfileSourceUnchanged,
  loadComposedProjectBinding,
  readLinkedSpawnfileSource,
  writePrivateComposedJson,
} from "./composedProjectPreflight.js";
import { compileReportMemberEngines } from "./compiledOrganizationIdentity.js";
import { composedIdempotencyKey, composedOrganizationContainerName } from
  "./composedBootstrapContract.js";
import { createComposedBootstrapDirectories,
  type ComposedBootstrapPaths } from "./composedBootstrapPaths.js";
import type { PreparedComposedBootstrap } from "./composedBootstrapState.js";
import {
  type AdmittedComposedSpawnfile,
  bindComposedTargetArchitecture,
} from "./composedSpawnfileAdmission.js";
import { describeComposedProject } from "./composedProjectDescriptor.js";
import { writePreflightCompileReport } from "./composedPreflightReport.js";
import type { ComposedCommandMode } from "./runArguments.js";

export const prepareLocalComposedBootstrap = async (input: Readonly<{
  admitted: AdmittedComposedSpawnfile;
  command_mode: ComposedCommandMode;
  environment: NodeJS.ProcessEnv;
  paths: ComposedBootstrapPaths;
  run_id: string;
  seed: string;
  signal?: AbortSignal;
  simfile: Simfile;
  simfile_path: string;
  source_text: string;
  spawnfile_path: string;
  target_context: string;
}>): Promise<PreparedComposedBootstrap> => {
  await createComposedBootstrapDirectories(input.paths);
  let admitted = input.admitted;
  const baseImage = input.environment.SIMFILE_SPAWNFILE_BASE_IMAGE
    ?? "node:22-bookworm-slim";
  const dockerCommand = input.environment.SIMFILE_SPAWNFILE_DOCKER_COMMAND ?? "docker";
  const target = await runSpawnfileTargetConfigPreview({ base_image: baseImage,
    context: admitted.context, docker_command: dockerCommand,
    evidence_destination: input.paths.world_evidence_archive,
    local_context: input.target_context, signal: input.signal });
  admitted = bindComposedTargetArchitecture(admitted, target.platform.architecture);
  const spawnfileSource = await readLinkedSpawnfileSource(input.spawnfile_path);
  const binding = await loadComposedProjectBinding(input.simfile_path, input.simfile);
  const preparation = await binding.prepareComposedProject({
    base_image_config_digest: target.base_image.config_digest,
    evidence_root: "/var/lib/simfile/evidence",
    internal_port: 4070,
    organization_container_name: composedOrganizationContainerName(input.run_id),
    platform: target.platform,
    run_id: input.run_id,
    secret_root: "/run/spawnfile-secrets",
    seed: input.seed,
    simfile_path: input.simfile_path,
    spawnfile_path: input.spawnfile_path,
  });
  const bundle = preparation.bundle;
  const claims = { archiveDigest: bundle.archive_sha256,
    artifactDigest: bundle.manifest.artifact.service_digest,
    baseImageConfigDigest: target.base_image.config_digest,
    bundleDigest: bundle.manifest.digest, entrypoint: bundle.manifest.entrypoint,
    launcherDigest: bundle.manifest.launcher.sha256,
    networkAlias: bundle.manifest.network.dns_alias, platform: target.platform };
  const policy = await runSpawnfileDeriveBundlePolicy(admitted.context, claims, input.signal);
  const mapping = { archive_digest: bundle.archive_sha256,
    artifact_manifest_digest: bundle.manifest.artifact.service_digest,
    base_image_config_digest: target.base_image.config_digest,
    build_policy_digest: policy.build_policy_digest, bundle_digest: bundle.manifest.digest,
    entrypoint: bundle.manifest.entrypoint, launcher_digest: bundle.manifest.launcher.sha256,
    network_alias: bundle.manifest.network.dns_alias, platform: target.platform,
    platform_digest: policy.platform_digest };
  await writePrivateComposedJson(input.paths.prepared_plan, {
    evidence_destination: input.paths.world_evidence_archive,
    prepared_artifact_mapping: mapping,
    version: "spawnfile.target-config-prepared-plan.v1",
  });
  const rawReport = await runSpawnfileCompile(admitted.context, {
    compiled_output_directory: input.paths.compiled,
    organization_path: input.spawnfile_path,
    signal: input.signal,
  });
  const snapshot = await writePreflightCompileReport(input.paths.preflight_report, rawReport);
  const report = snapshot.report;
  if (report.container.moltnet?.release !== undefined
    && report.container.moltnet.release.architecture !== target.platform.architecture) {
    throw new TypeError("Spawnfile compile target architecture changed");
  }
  await assertLinkedSpawnfileSourceUnchanged(spawnfileSource);
  if (await readFile(input.simfile_path, "utf8") !== input.source_text) {
    throw new TypeError("Simfile source changed during composed bootstrap");
  }
  const authentication = resolveSpawnfileOrganizationAuthentication({
    configured_auth_profile: input.environment.SPAWNFILE_AUTH_PROFILE,
    member_engines: compileReportMemberEngines(report),
  });
  const project = describeComposedProject({
    authentication_profile: authentication.correlation_auth_profile,
    build_policy_digest: policy.build_policy_digest,
    compile_fingerprint: report.compile_fingerprint,
    platform_digest: policy.platform_digest,
    preparation, run_id: input.run_id, selected_context: input.target_context,
    simfile_source: input.source_text, spawnfile_source: spawnfileSource.bytes, target,
  });
  await writePrivateComposedJson(input.paths.grants_file, { grants:
    project.credential_projection.world_members.map((member) => ({
      capability_manifest: member.capability_manifest, member_id: member.id,
      principal_id: member.principal_id })), run_id: input.run_id,
    version: "spawnfile.auth.resolved-world-grants.v1",
    world_instance_id: preparation.readiness_expectation.world_instance_id });
  const capsule = parseComposedBootstrapCapsule({ command_mode: input.command_mode,
    paths: { compiled: input.paths.compiled, env_file: input.paths.env_file,
      grants_file: input.paths.grants_file, journal: input.paths.journal,
      organization_evidence: input.paths.organization_evidence,
      organization_path: input.spawnfile_path, preflight_report: input.paths.preflight_report,
      prepared_plan: input.paths.prepared_plan,
      run: input.paths.run, selected_target_file: input.paths.selected_target_file,
      simfile: input.simfile_path, support_root: input.paths.support_root,
      world_bindings_file: input.paths.world_bindings_file,
      world_evidence: input.paths.world_evidence,
      world_evidence_archive: input.paths.world_evidence_archive },
    project: { compile_fingerprint: report.compile_fingerprint,
      descriptor_digest: project.descriptor_digest,
      preflight_report_digest: snapshot.digest, seed: input.seed,
      simfile_source_digest: project.simfile_source_digest,
      spawnfile_source_digest: project.spawnfile_source_digest },
    provider: { base_image: target.base_image.reference,
      capability_contract_digest: admitted.capability_contract_digest,
      context: input.target_context, docker_command: dockerCommand,
      process_environment: admitted.process_environment,
      spawnfile_bin: admitted.identity.path, spawnfile_cwd: path.dirname(input.simfile_path),
      spawnfile_executable_sha256: admitted.identity.sha256,
      spawnfile_package_version: admitted.package_version },
    run_id: input.run_id, version: "simfile.composed-bootstrap-capsule.v2" });
  const journal = createBootstrapComposedPhaseJournal(
    project.request, capsule, new Date().toISOString(),
  );
  const journalSession = await createComposedJournalSession(input.paths.journal, journal);
  return Object.freeze({ authentication, base_image: target.base_image.reference,
    bundle_request_base: project.bundle_request_base, capsule,
    cli: admitted.context, command_mode: input.command_mode,
    credential_projection: project.credential_projection,
    docker_command: dockerCommand, journal_session: journalSession, paths: input.paths,
    preparation, report, request: project.request,
    selected_request: Object.freeze({ idempotency_key: composedIdempotencyKey(
      "simfile.composed-select-target.v1", { context: input.target_context,
        run_id: input.run_id }), operation: "select_target",
      target_reference: input.target_context,
      version: "spawnfile.target-resource.request.v1" }) });
};
