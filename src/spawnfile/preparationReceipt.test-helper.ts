import { digestComposedJson } from "../compose/json.js";
import {
  createSpawnfileComposedPreparationRequestDigest,
  parseSpawnfileComposedPreparationRequest,
} from "./preparationReceipt.js";

const sha = (value: string): `sha256:${string}` =>
  `sha256:${value.repeat(64).slice(0, 64)}`;

export const composedPreparationRequestFixture = () =>
  parseSpawnfileComposedPreparationRequest({
    auth_profile: "test-auth-profile",
    descriptor_digest: sha("a"),
    idempotency_key: "idem_prepare0000000000",
    organization: { artifact_digest: sha("b"), world_bindings_digest: sha("c") },
    run_id: "run-one",
    secret_bindings: [{
      name: "world_bearer", scope: "world", source_handle: `opaque_${"d".repeat(16)}`,
    }],
    target_selector: "local-test-target",
    version: "spawnfile.composed-preparation.request.v1",
    world: { artifact_manifest_digest: sha("e"), bundle_digest: sha("f") },
  });

export const composedPreparationReceiptFixture = () => {
  const request = composedPreparationRequestFixture();
  const target = {
    fingerprint: `sha256:${"1".repeat(32)}`,
    handle: `opaque_${"2".repeat(16)}`,
    version: "spawnfile.target-resource.selected-target.v1" as const,
  };
  const resource = (operation: string, revision: number) => {
    const body = {
      additive_resource_field: { future: true },
      cleanup_state: "not_requested",
      descriptor_digest: request.descriptor_digest,
      export_state: "not_requested",
      labels: [],
      operation,
      operation_handle: `opaque_${String(revision).repeat(16)}`,
      request_digest: sha(String(revision + 3)),
      result_handle: `opaque_${String(revision + 4).repeat(16)}`,
      resulting_revision: revision,
      run_id: request.run_id,
      selected_target: { fingerprint: target.fingerprint, handle: target.handle },
      version: "spawnfile.target-resource.receipt.v1",
    };
    return {
      ...body,
      receipt_digest: digestComposedJson("spawnfile.target-resource.receipt.v1", body),
    };
  };
  const body = {
    additive_top_level: { future: "preserved" },
    auth_profile: request.auth_profile,
    descriptor_digest: request.descriptor_digest,
    organization: { ...request.organization, future: true },
    request_digest: createSpawnfileComposedPreparationRequestDigest(request),
    resources: {
      data_network: resource("create_data_network", 3),
      evidence_volume: resource("create_evidence_volume", 4),
      future: true,
      secret_bindings: resource("prepare_secret_bindings", 2),
      world_artifact: resource("resolve_world_artifact", 1),
    },
    run_id: request.run_id,
    selected_target: { ...target, future: true },
    target_selector: request.target_selector,
    version: "spawnfile.composed-preparation.receipt.v1",
    world: { ...request.world, future: true },
  };
  return {
    ...body,
    receipt_digest: digestComposedJson("spawnfile.composed-preparation.receipt.v1", body),
  };
};
