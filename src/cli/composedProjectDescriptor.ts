import { Buffer } from "node:buffer";

import {
  parseComposedRunRequest,
  type ComposedProjectPreparation,
  type ComposedRunRequest,
} from "../compose/index.js";
import { digestComposedJson } from "../compose/json.js";
import type { SpawnfileBundleRequest } from "../spawnfile/containerBundleCli.js";
import type { SpawnfileTargetConfigPreview } from "../spawnfile/targetConfigPreview.js";
import { RUNNABLE_WORLD_SIDECAR_ARCHIVE_PATHS } from "../world-artifact/index.js";
import { deriveCompiledOrganizationArtifactDigest } from
  "./compiledOrganizationIdentity.js";
import { createComposedWorldBindings } from "./composedWorldBindings.js";
import { projectCredentialBindingNames } from "./credentialBindingProjection.js";
import { sha256 } from "./composedBootstrapContract.js";

export type ComposedCredentialProjection = Readonly<{
  credentials: ComposedProjectPreparation["credentials"];
  secret_bindings: ComposedProjectPreparation["secret_bindings"];
  world_members: ComposedProjectPreparation["world_members"];
}>;

export const describeComposedProject = (input: Readonly<{
  authentication_profile: string;
  build_policy_digest: string;
  compile_fingerprint: string;
  platform_digest: string;
  preparation: ComposedProjectPreparation;
  run_id: string;
  selected_context: string;
  simfile_source: string;
  spawnfile_source: Uint8Array;
  target: SpawnfileTargetConfigPreview;
}>): Readonly<{
  bundle_request_base: Omit<SpawnfileBundleRequest, "idempotency_key" | "selected_target">;
  credential_projection: ComposedCredentialProjection;
  descriptor_digest: `sha256:${string}`;
  request: ComposedRunRequest;
  simfile_source_digest: `sha256:${string}`;
  spawnfile_source_digest: `sha256:${string}`;
  world_bindings_digest: `sha256:${string}`;
}> => {
  const bundle = input.preparation.bundle;
  const credentialProjection = projectCredentialBindingNames(input.preparation);
  const environmentByName = new Map(credentialProjection.credentials.map(
    (credential) => [credential.name, credential.env],
  ));
  const jsonUrl = `http://${bundle.manifest.network.dns_alias}:`
    + `${bundle.manifest.network.internal_port}/v1/world`;
  const mcpUrl = `http://${bundle.manifest.network.dns_alias}:`
    + `${bundle.manifest.network.internal_port}/mcp`;
  const predicted = createComposedWorldBindings({ json_url: jsonUrl, mcp_url: mcpUrl,
    members: credentialProjection.world_members.map((member) => ({
      capability_manifest: member.capability_manifest,
      id: member.id,
      principal_id: member.principal_id,
      token_env: environmentByName.get(member.token_credential_name) ?? "",
    })), run_id: input.run_id,
    world_instance_id: input.preparation.readiness_expectation.world_instance_id });
  const simfileDigest = sha256(input.simfile_source);
  const spawnfileDigest = sha256(input.spawnfile_source);
  const descriptorDigest = digestComposedJson("simfile.composed-project-descriptor.v1", {
    organization: input.compile_fingerprint,
    simfile: simfileDigest,
    spawnfile: spawnfileDigest,
    world: bundle.manifest.digest,
  });
  const request = parseComposedRunRequest({ descriptor_digest: descriptorDigest, mode: "live",
    organization: {
      artifact_digest: deriveCompiledOrganizationArtifactDigest(input.compile_fingerprint),
      source_digest: spawnfileDigest,
      world_bindings_digest: predicted.digest,
    }, required_world_capabilities: ["simfile.world-decision-claim.v1"],
    run_id: input.run_id, source_digest: simfileDigest,
    target: { auth_profile: input.authentication_profile,
      selector: input.selected_context },
    version: "simfile.composed-run-request.v1",
    world: { artifact_manifest_digest: bundle.manifest.artifact.service_digest,
      bundle_digest: bundle.manifest.digest,
      runtime_abi: "simfile.world-sidecar-runtime.v1" } });
  return Object.freeze({
    bundle_request_base: Object.freeze({
      archive_base64: Buffer.from(bundle.archive_bytes).toString("base64"),
      archive_digest: bundle.archive_sha256,
      archive_entries: [...RUNNABLE_WORLD_SIDECAR_ARCHIVE_PATHS],
      artifact_digest: bundle.manifest.artifact.service_digest,
      build_policy_digest: input.build_policy_digest,
      bundle_digest: bundle.manifest.digest,
      entrypoint: bundle.manifest.entrypoint,
      launcher_digest: bundle.manifest.launcher.sha256,
      network_alias: bundle.manifest.network.dns_alias,
      platform: input.target.platform,
      platform_digest: input.platform_digest,
      version: "spawnfile.target-local-container-bundle.prepare-request.v1",
    }),
    credential_projection: credentialProjection,
    descriptor_digest: descriptorDigest,
    request,
    simfile_source_digest: simfileDigest,
    spawnfile_source_digest: spawnfileDigest,
    world_bindings_digest: predicted.digest,
  });
};
