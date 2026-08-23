import {
  bindComposedJournalExecution,
} from "../compose/index.js";
import { canonicalComposedJson } from "../compose/json.js";
import { bootstrapJournaledTarget } from "../spawnfile/targetBootstrap.js";
import { provisionJournaledCredentials } from
  "../spawnfile/journaledCredentialProvisioning.js";
import { writeOrVerifyPrivateComposedJson } from "./composedProjectPreflight.js";
import {
  composedIdempotencyKey,
} from "./composedBootstrapContract.js";
import { createComposedCredentialRequest } from "./composedCredentialRequest.js";
import { createBoundComposedExecution } from "./composedExecutionBinding.js";
import type {
  LinkedComposedBootstrap,
  PreparedComposedBootstrap,
} from "./composedBootstrapState.js";

export const finalizeComposedBootstrap = async (
  state: PreparedComposedBootstrap,
  signal?: AbortSignal,
): Promise<LinkedComposedBootstrap> => {
  const target = await bootstrapJournaledTarget({
    base_image: state.base_image,
    context: state.cli,
    create_bundle_request: (selected) => ({
      ...state.bundle_request_base,
      idempotency_key: composedIdempotencyKey(
        "simfile.composed-prepare-bundle.v1",
        { bundle_digest: state.request.world.bundle_digest,
          run_id: state.request.run_id, selected_target: selected },
      ),
      selected_target: { fingerprint: selected.fingerprint, handle: selected.handle },
    }),
    docker_command: state.docker_command,
    evidence_destination: state.paths.world_evidence_archive,
    journal_session: state.journal_session,
    local_context: state.request.target.selector,
    prepared_plan: state.paths.prepared_plan,
    select_request: state.selected_request,
    signal,
  });
  let succeeded = false;
  try {
    await writeOrVerifyPrivateComposedJson(
      state.paths.selected_target_file, target.selected_target,
    );
    const network = state.preparation.bundle.manifest.network;
    const credentialRequest = createComposedCredentialRequest({
    authentication: state.authentication,
    descriptor_digest: state.request.descriptor_digest,
    json_url: `http://${network.dns_alias}:${network.internal_port}/v1/world`,
    mcp_url: `http://${network.dns_alias}:${network.internal_port}/mcp`,
    projection: state.credential_projection,
    run_id: state.request.run_id,
    selected_target: target.selected_target,
    world_instance_id: state.preparation.readiness_expectation.world_instance_id,
    });
    const auth = await provisionJournaledCredentials({ context: state.cli,
    env_file: state.paths.env_file, journal_session: state.journal_session,
    request: credentialRequest, resolved_grants_file: state.paths.grants_file,
    signal, world_bindings_file: state.paths.world_bindings_file });
    const bound = createBoundComposedExecution({ auth, bootstrap: state,
      resolution: target.resolution, selected_target: target.selected_target });
    const current = state.journal_session.current();
    if (current.execution === undefined) {
      const journal = bindComposedJournalExecution(current, bound.execution, bound.binding);
      await state.journal_session.replace(current, journal);
    } else if (canonicalComposedJson(current.execution)
      !== canonicalComposedJson(bound.execution)
      || canonicalComposedJson(current.bootstrap_binding)
        !== canonicalComposedJson(bound.binding)) {
      throw new TypeError("composed bound execution identity changed during recovery");
    }
    if (canonicalComposedJson(state.journal_session.current().bootstrap_binding)
      !== canonicalComposedJson(bound.binding)) {
      throw new TypeError("composed execution binding was not committed exactly once");
    }
    const result = Object.freeze({
    auth,
    command_mode: state.command_mode,
    compile_fingerprint: state.report.compile_fingerprint,
    execution: bound.execution,
    journal_path: state.paths.journal,
    journal_session: state.journal_session,
    organization_evidence_directory: state.paths.organization_evidence,
    preparation: state.preparation,
    request: state.request,
    run_id: state.request.run_id,
    run_path: state.paths.run,
    source_handles: Object.freeze(auth.credentials.map(({ source_handle }) => source_handle)),
    support_root: state.paths.support_root,
    target_provider: target.provider,
    trusted_project_root: state.capsule.provider.spawnfile_cwd,
      world_evidence_directory: state.paths.world_evidence,
    });
    succeeded = true;
    return result;
  } finally {
    if (!succeeded) target.provider.close();
  }
};
