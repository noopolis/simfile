import type { SpawnfileCredentialProvisioningReceipt } from
  "../spawnfile/bootstrapCli.js";
import type { SpawnfileOrganizationAuthentication } from
  "../spawnfile/organizationAuthentication.js";
import type { SpawnfileSelectedTarget } from "../spawnfile/targetSelection.js";
import type { ComposedCredentialProjection } from "./composedProjectDescriptor.js";

export const createComposedCredentialRequest = (input: Readonly<{
  authentication: SpawnfileOrganizationAuthentication;
  descriptor_digest: string;
  json_url: string;
  mcp_url: string;
  projection: ComposedCredentialProjection;
  run_id: string;
  selected_target: SpawnfileSelectedTarget;
  world_instance_id: string;
}>): Readonly<Record<string, unknown>> => Object.freeze({
  credentials: input.projection.credentials,
  descriptor_digest: input.descriptor_digest,
  ...(input.authentication.kind === "model"
    && input.authentication.model_engine_auth !== undefined
    ? { model_engine_auth: input.authentication.model_engine_auth } : {}),
  run_id: input.run_id,
  scope: "world",
  selected_target: input.selected_target,
  version: "spawnfile.auth.credential-provisioning.request.v1",
  world_bindings: {
    json_url: input.json_url,
    mcp_url: input.mcp_url,
    members: input.projection.world_members.map(
      ({ id, principal_id, token_credential_name }) =>
        ({ id, principal_id, token_credential_name }),
    ),
    world_instance_id: input.world_instance_id,
  },
});

export const bindComposedSecretSources = (input: Readonly<{
  projection: ComposedCredentialProjection;
  receipt: SpawnfileCredentialProvisioningReceipt;
}>): readonly Readonly<{ name: string; scope: string; source_handle: string }>[] => {
  const sourceByName = new Map(input.receipt.credentials.map(
    ({ name, source_handle }) => [name, source_handle],
  ));
  return Object.freeze(input.projection.secret_bindings.map((binding) => {
    const source = sourceByName.get(binding.credential_name);
    if (source === undefined) {
      throw new TypeError("Spawnfile credential receipt omitted a composed secret binding");
    }
    return Object.freeze({ name: binding.name, scope: binding.scope,
      source_handle: source });
  }));
};
