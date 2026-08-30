import { z } from "zod";

import type { ComposedExecution } from "../compose/execution.js";
import type { ComposedJournalSession } from "../compose/journalSession.js";
import { digestComposedJson } from "../compose/json.js";
import { composedPhasePayload } from "../compose/phase.js";
import type { ComposedRunPorts } from "../compose/run.js";
import {
  createComposedWorldResourceReceipt,
  createComposedWorldServiceReceipt,
} from "../compose/startup-world.js";
import type { ComposedTargetProvider } from "./composedTargetProvider.js";
import {
  createProductionTargetDriver,
  productionRecord as record,
} from "./productionTarget.js";
import {
  parseTargetResourceReceipt,
  verifyTargetReadinessReceipt,
  verifyTargetResourceReceipt,
} from "./targetReceipts.js";

type Driver = ReturnType<typeof createProductionTargetDriver>;
const handle = z.string().regex(/^opaque_[a-z0-9]{16,64}$/u);

export const createProductionPreparationPort = (input: Readonly<{
  execution: ComposedExecution;
  journal_session: ComposedJournalSession;
  target_provider?: ComposedTargetProvider;
}>, driver: Driver): ComposedRunPorts["preparation"] => ({
  prepareComposedRun: async ({ idempotency_key, request, signal }) => {
    await driver.guard();
    return driver.targetProvider.prepare({
      journal_session: input.journal_session,
      request: {
        auth_profile: request.target.auth_profile,
        descriptor_digest: request.descriptor_digest,
        idempotency_key,
        organization: {
          artifact_digest: request.organization.artifact_digest,
          world_bindings_digest: request.organization.world_bindings_digest,
        },
        run_id: request.run_id,
        secret_bindings: input.execution.secret_bindings,
        target_selector: request.target.selector,
        version: "spawnfile.composed-preparation.request.v1",
        world: {
          artifact_manifest_digest: request.world.artifact_manifest_digest,
          bundle_digest: request.world.bundle_digest,
        },
      },
      signal,
    });
  },
});

export const createProductionWorldPort = (
  execution: ComposedExecution,
  driver: Driver,
): ComposedRunPorts["world"] => {
  const provider = execution.provider;
  const { completeTarget, load, mutation, runTarget, selectedTarget } = driver;
  return {
    createWorldResource: async ({ idempotency_key, signal }) => {
      const journal = await load();
      const preparation = record(composedPhasePayload(journal, "prepared").preparation);
      const resources = record(preparation.resources);
      const request = mutation(journal, "create_world_service", idempotency_key, 4, {
        data_network_handle: record(resources.data_network).result_handle,
        evidence_mount_path: provider.evidence_mount_path,
        evidence_volume_handle: record(resources.evidence_volume).result_handle,
        secret_bindings_handle: record(resources.secret_bindings).result_handle,
        world_artifact_handle: record(resources.world_artifact).result_handle,
      });
      const target = verifyTargetResourceReceipt({ operation: "create_world_service",
        raw: await runTarget("create_world_service", request, signal), request,
        resulting_revision: 5, run_id: journal.request.run_id });
      await completeTarget("create_world_service", request, target);
      if (target.result_handle === null) throw new TypeError("world handle is missing");
      return createComposedWorldResourceReceipt({
        artifact_digest: journal.request.world.artifact_manifest_digest,
        bundle_digest: journal.request.world.bundle_digest,
        preparation_receipt_digest: z.string().parse(preparation.receipt_digest),
        resource_handle: `opaque_${digestComposedJson(
          "simfile.composed-world-resource-handle.v1",
          { operation_handle: target.operation_handle, run_id: journal.request.run_id },
        ).slice(7, 39)}`,
        run_id: journal.request.run_id, target_operation: target,
      });
    },
    startWorldPaused: async ({ idempotency_key, resource, signal }) => {
      const journal = await load();
      const created = parseTargetResourceReceipt(resource.target_operation);
      if (created.result_handle === null) throw new TypeError("world service handle is missing");
      const request = mutation(journal, "start_world_service", idempotency_key, 5,
        { world_service_handle: created.result_handle });
      const target = verifyTargetResourceReceipt({ operation: "start_world_service",
        raw: await runTarget("start_world_service", request, signal), request,
        resulting_revision: 6, run_id: journal.request.run_id });
      await completeTarget("start_world_service", request, target);
      return createComposedWorldServiceReceipt({ resource_handle: resource.resource_handle,
        run_id: journal.request.run_id, service_handle: handle.parse(target.result_handle),
        target_operation: target });
    },
    readWorldReadiness: async ({ service, signal }) => {
      const journal = await load();
      const { run_id: _runId, ...expected } = execution.configuration.readiness_expectation;
      const request = {
        descriptor_digest: journal.request.descriptor_digest,
        endpoint: { internal_port: provider.world_readiness_port, path: "/v1/world/readiness" },
        expected: { ...expected, document_version: "simfile.world-sidecar-readiness.v1",
          runtime_abi: journal.request.world.runtime_abi },
        run_id: journal.request.run_id, selected_target: selectedTarget,
        version: "spawnfile.target-world-readiness.request.v1",
        world_service_handle: service.service_handle,
      };
      return verifyTargetReadinessReceipt({
        raw: await runTarget("query_world_readiness", request, signal), request,
      });
    },
  };
};
