import {
  COMPOSED_EXECUTION_VERSION,
  composedBootstrapDigest,
  createComposedBootstrapBinding,
  createComposedRunRequestDigest,
  parseComposedExecution,
  type ComposedExecution,
} from "../compose/index.js";
import { canonicalComposedJson, digestComposedJson } from "../compose/json.js";
import type { SpawnfileCredentialProvisioningReceipt } from
  "../spawnfile/bootstrapCli.js";
import type { SpawnfileTargetConfigResolution } from
  "../spawnfile/targetConfigResolution.js";
import type { SpawnfileSelectedTarget } from "../spawnfile/targetSelection.js";
import { compileReportMemberEngines,
  compileReportMoltnetReleaseExpectation } from "./compiledOrganizationIdentity.js";
import {
  composedDeploymentName,
  composedOrganizationContainerName,
  composedOrganizationUnitId,
  composedProviderLifecycleInvocations,
  sha256,
} from "./composedBootstrapContract.js";
import type { PreparedComposedBootstrap } from "./composedBootstrapState.js";
import { bindComposedSecretSources } from "./composedCredentialRequest.js";

export const createBoundComposedExecution = (input: Readonly<{
  auth: SpawnfileCredentialProvisioningReceipt;
  bootstrap: PreparedComposedBootstrap;
  resolution: SpawnfileTargetConfigResolution["identity"];
  selected_target: SpawnfileSelectedTarget;
}>): Readonly<{
  binding: ReturnType<typeof createComposedBootstrapBinding>;
  execution: ComposedExecution;
}> => {
  const state = input.bootstrap;
  if (input.auth.world_bindings_digest
    !== state.request.organization.world_bindings_digest) {
    throw new TypeError("Spawnfile world-binding artifact changed after credential provisioning");
  }
  const selectedDigest = sha256(canonicalComposedJson(input.selected_target));
  const requestDigest = createComposedRunRequestDigest(state.request);
  const execution = parseComposedExecution({
    configuration: {
      organization_expectation: {
        deployment_name: composedDeploymentName(state.request.run_id),
        member_engines: compileReportMemberEngines(state.report),
        ...(compileReportMoltnetReleaseExpectation(state.report) === undefined ? {} : {
          moltnet_release: compileReportMoltnetReleaseExpectation(state.report),
        }),
        selected_target_receipt_digest: selectedDigest,
        unit_id: composedOrganizationUnitId(state.request.run_id),
        world_binding_digest: input.auth.world_bindings_digest,
      },
      readiness_expectation: state.preparation.readiness_expectation,
      terminal_tick: state.preparation.terminal_tick,
      topology_expectation: { selected_target: {
        fingerprint: input.selected_target.fingerprint,
        handle: input.selected_target.handle,
      } },
    },
    provider: {
      compiled_output_directory: state.paths.compiled,
      evidence_destination_directory: state.paths.organization_evidence,
      evidence_mount_path: "/var/lib/simfile/evidence",
      lifecycle_invocations: composedProviderLifecycleInvocations(
        state.request.run_id, requestDigest,
      ),
      organization_handoff: { env_file: state.paths.env_file,
        selected_target_receipt_file: state.paths.selected_target_file,
        world_bindings_file: state.paths.world_bindings_file },
      organization_container_name: composedOrganizationContainerName(state.request.run_id),
      organization_image_tag: `simfile-org-${requestDigest.slice(7, 23)}:run`,
      organization_path: state.capsule.paths.organization_path,
      process_environment: state.capsule.provider.process_environment,
      spawnfile_bin: state.capsule.provider.spawnfile_bin,
      spawnfile_capability_contract_digest:
        state.capsule.provider.capability_contract_digest,
      spawnfile_cwd: state.capsule.provider.spawnfile_cwd,
      spawnfile_executable_sha256: state.capsule.provider.spawnfile_executable_sha256,
      spawnfile_package_version: state.capsule.provider.spawnfile_package_version,
      target_resolution: input.resolution,
      terminal_artifact: { id: "composed_terminal", max_bytes: 131_072,
        path: "/tmp/spawnfile-public/composed-terminal.json" },
      world_evidence_export: { archive_path: state.paths.world_evidence_archive,
        destination_directory: state.paths.world_evidence },
      world_readiness_port: state.preparation.bundle.manifest.network.internal_port,
    },
    secret_bindings: bindComposedSecretSources({ projection: state.credential_projection,
      receipt: input.auth }),
    version: COMPOSED_EXECUTION_VERSION,
  });
  const journal = state.journal_session.current();
  const binding = createComposedBootstrapBinding({
    bootstrap_authority_digest: journal.authority_digest,
    bootstrap_digest: composedBootstrapDigest(state.capsule),
    execution_digest: digestComposedJson(COMPOSED_EXECUTION_VERSION, execution),
    request_digest: journal.request_digest,
    run_id: state.request.run_id,
    target: { context: input.resolution.context,
      prepared_evidence_helper: input.resolution.prepared_evidence_helper,
      selected_target: { fingerprint: input.selected_target.fingerprint,
        handle: input.selected_target.handle },
      selected_target_receipt_digest: selectedDigest,
      target_config_digest: input.resolution.target_config_digest },
  });
  return Object.freeze({ binding, execution });
};
