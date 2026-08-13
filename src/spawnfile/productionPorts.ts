import { z } from "zod";
import { createComposedTopologyActivationReceipt, createComposedTopologyAttestationReceipt, createComposedWorldTickReceipt } from "../compose/activation.js";
import { createComposedCleanupOperationReceipt } from "../compose/cleanup.js";
import type { ComposedExecution } from "../compose/execution.js";
import type { ComposedJournalSession } from "../compose/journalSession.js";
import {
  createComposedWorldEvidenceReceipt,
  createComposedWorldPauseReceipt,
} from "../compose/finalize-world.js";
import { digestComposedJson } from "../compose/json.js";
import { composedPhasePayload } from "../compose/phase.js";
import type { ComposedRunPorts } from "../compose/run.js";
import {
  createComposedWorldResourceReceipt,
  createComposedWorldServiceReceipt,
  parseComposedWorldServiceReceipt,
} from "../compose/startup-world.js";
import {
  runSpawnfileArtifactsExport,
  runSpawnfileComposedPreparation,
  runSpawnfileDown,
} from "./cli.js";
import { runSpawnfileConfigProducer } from "./process.js";
import { worldInventoryFromTargetExport } from "./evidenceInventory.js";
import { createProductionOrganizationPorts } from "./productionOrganizationPorts.js";
import { createProductionTargetDriver, productionRecord as record } from "./productionTarget.js";
import { waitForProductionWorldTerminal } from "./productionTerminal.js";
import {
  parseTargetResourceReceipt,
  verifyTargetReadinessReceipt,
  verifyTargetResourceReceipt,
  verifyTargetWorldClockReceipt,
} from "./targetReceipts.js";
import { materializeWorldEvidenceArchive } from "./worldEvidenceArchive.js";
const handle = z.string().regex(/^opaque_[a-z0-9]{16,64}$/u);
/** Creates the production composed ports using only built public Spawnfile commands. */
export const createProductionComposedRunPorts = (input: Readonly<{ execution: ComposedExecution;
  journal_session: ComposedJournalSession }>): ComposedRunPorts => {
  const execution = input.execution;
  const provider = execution.provider;
  const driver = createProductionTargetDriver(input);
  const { cli, guard, load, mutation, runTarget, selectedTarget, topologyRequest } = driver;
  return {
    preparation: {
      prepareComposedRun: async ({ idempotency_key, request, signal }) => {
        await guard();
        const config = await runSpawnfileConfigProducer({
          args: provider.target_config_producer.args,
          command: provider.target_config_producer.command,
          cwd: provider.spawnfile_cwd,
          env: provider.process_environment === undefined
            ? process.env : { ...process.env, ...provider.process_environment },
          signal,
        });
        try {
          await guard();
          return await runSpawnfileComposedPreparation(cli, {
            request: {
              auth_profile: request.target.auth_profile,
              descriptor_digest: request.descriptor_digest,
              idempotency_key,
              organization: {
                artifact_digest: request.organization.artifact_digest,
                world_bindings_digest: request.organization.world_bindings_digest,
              },
              run_id: request.run_id,
              secret_bindings: execution.secret_bindings,
              target_selector: request.target.selector,
              version: "spawnfile.composed-preparation.request.v1",
              world: {
                artifact_manifest_digest: request.world.artifact_manifest_digest,
                bundle_digest: request.world.bundle_digest,
              },
            },
            signal,
            targetConfigStdin: config,
          });
        } finally {
          config.fill(0);
        }
      },
    },
    world: {
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
        const targetOperation = verifyTargetResourceReceipt({
          operation: "create_world_service",
          raw: await runTarget("create_world_service", request, signal),
          request, resulting_revision: 5, run_id: journal.request.run_id,
        });
        if (targetOperation.result_handle === null) throw new TypeError("world handle is missing");
        return createComposedWorldResourceReceipt({
          artifact_digest: journal.request.world.artifact_manifest_digest,
          bundle_digest: journal.request.world.bundle_digest,
          preparation_receipt_digest: z.string().parse(preparation.receipt_digest),
          resource_handle: `opaque_${digestComposedJson(
            "simfile.composed-world-resource-handle.v1",
            { operation_handle: targetOperation.operation_handle, run_id: journal.request.run_id },
          ).slice(7, 39)}`,
          run_id: journal.request.run_id,
          target_operation: targetOperation,
        });
      },
      startWorldPaused: async ({ idempotency_key, resource, signal }) => {
        const journal = await load();
        const created = parseTargetResourceReceipt(resource.target_operation);
        if (created.result_handle === null) throw new TypeError("world service handle is missing");
        const request = mutation(journal, "start_world_service", idempotency_key, 5, {
          world_service_handle: created.result_handle,
        });
        const targetOperation = verifyTargetResourceReceipt({
          operation: "start_world_service",
          raw: await runTarget("start_world_service", request, signal),
          request, resulting_revision: 6, run_id: journal.request.run_id,
        });
        return createComposedWorldServiceReceipt({
          resource_handle: resource.resource_handle,
          run_id: journal.request.run_id,
          service_handle: handle.parse(targetOperation.result_handle),
          target_operation: targetOperation,
        });
      },
      readWorldReadiness: async ({ service, signal }) => {
        const journal = await load();
        const expected = execution.configuration.readiness_expectation;
        const request = {
          descriptor_digest: journal.request.descriptor_digest,
          endpoint: { internal_port: provider.world_readiness_port, path: "/v1/world/readiness" },
          expected: {
            ...expected,
            document_version: "simfile.world-sidecar-readiness.v1",
            runtime_abi: journal.request.world.runtime_abi,
            run_id: undefined,
          },
          run_id: journal.request.run_id,
          selected_target: selectedTarget,
          version: "spawnfile.target-world-readiness.request.v1",
          world_service_handle: service.service_handle,
        };
        delete (request.expected as { run_id?: unknown }).run_id;
        return verifyTargetReadinessReceipt({
          raw: await runTarget("query_world_readiness", request, signal), request,
        });
      },
    },
    organization: createProductionOrganizationPorts(execution, driver),
    topology: {
      attestTopology: async ({ organization_phase_digest, request_digest, signal, world_phase_digest }) => {
        const request = await topologyRequest();
        const targetTopology = await runTarget("attest_topology", request, signal);
        return createComposedTopologyAttestationReceipt({
          organization_phase_digest,
          request_digest,
          run_id: request.run_id,
          target_topology: targetTopology as never,
          world_phase_digest,
        });
      },
      activateTopology: async ({ attestation, signal }) => {
        const request = await topologyRequest();
        const targetActivation = await runTarget("activate_topology", request, signal);
        return createComposedTopologyActivationReceipt({
          attestation_receipt_digest: attestation.receipt_digest,
          run_id: request.run_id,
          target_activation: targetActivation as never,
        });
      },
      readFirstTick: async ({ activation, signal }) => {
        const journal = await load();
        const service = parseComposedWorldServiceReceipt(
          composedPhasePayload(journal, "world_started_paused").receipt,
        );
        const attestation = record(
          composedPhasePayload(journal, "topology_verified").attestation,
        );
        const targetTopology = record(attestation.target_topology);
        const targetActivation = activation.target_activation;
        const request = {
          activation_digest: targetActivation.activation_digest,
          activation_receipt_digest: targetActivation.receipt_digest,
          descriptor_digest: journal.request.descriptor_digest,
          endpoint: { internal_port: provider.world_readiness_port, path: "/v1/world/clock" },
          expected: {
            document_version: "simfile.world-sidecar-clock.v1",
            world_instance_id: execution.configuration.readiness_expectation.world_instance_id,
          },
          run_id: journal.request.run_id,
          selected_target: selectedTarget,
          topology_receipt_digest: targetTopology.receipt_digest,
          topology_request_digest: targetTopology.request_digest,
          version: "spawnfile.target-world-clock.request.v1",
          world_service_handle: service.service_handle,
        } as const;
        const observed = verifyTargetWorldClockReceipt({
          raw: await runTarget("query_world_clock", request, signal), request,
        });
        return createComposedWorldTickReceipt({
          activation_receipt_digest: activation.receipt_digest,
          clock: observed.clock,
          run_id: journal.request.run_id,
          world_phase_digest: journal.entries.find(({ phase }) => phase === "world_ready")!.payload_digest,
        });
      },
    },
    supervision: {
      waitForWorldTerminal: async ({ running, signal }) => {
        const journal = await load();
        const service = parseComposedWorldServiceReceipt(
          composedPhasePayload(journal, "world_started_paused").receipt,
        );
        return waitForProductionWorldTerminal({ journal, provider,
          run_target: runTarget, running, selected_target: selectedTarget,
          service_handle: service.service_handle, signal });
      },
    },
    world_finalization: {
      pauseWorld: async ({ idempotency_key, service, signal, terminal }) => {
        const journal = await load();
        const request = mutation(journal, "stop_world_service", idempotency_key, 7, {
          world_service_handle: service.service_handle,
        });
        const targetOperation = verifyTargetResourceReceipt({
          operation: "stop_world_service",
          raw: await runTarget("stop_world_service", request, signal),
          request, resulting_revision: 8, run_id: journal.request.run_id,
        });
        return createComposedWorldPauseReceipt({
          final_tick: terminal.terminal_tick,
          run_id: journal.request.run_id,
          service_handle: service.service_handle,
          target_operation: targetOperation,
          terminal_receipt_digest: terminal.receipt_digest,
        });
      },
      exportWorldEvidence: async ({ idempotency_key, pause, signal }) => {
        const journal = await load();
        const preparation = record(composedPhasePayload(journal, "prepared").preparation);
        const evidenceHandle = handle.parse(
          record(record(preparation.resources).evidence_volume).result_handle,
        );
        // Revision 8 is consumed by Spawnfile's deterministic, target-owned
        // evidence-helper admission immediately before the export mutation.
        const request = mutation(journal, "export_evidence_volume", idempotency_key, 9, {
          evidence_volume_handle: evidenceHandle,
        });
        const targetOperation = verifyTargetResourceReceipt({
          operation: "export_evidence_volume",
          raw: await runTarget("export_evidence_volume", request, signal),
          request, resulting_revision: 10, run_id: journal.request.run_id,
        });
        if (targetOperation.export_state !== "exported") {
          throw new TypeError("world evidence export is incomplete");
        }
        if (provider.world_evidence_export !== undefined) {
          if (targetOperation.evidence_index === undefined) {
            throw new TypeError("world evidence export index is absent");
          }
          await materializeWorldEvidenceArchive({
            archive_path: provider.world_evidence_export.archive_path,
            destination_directory: provider.world_evidence_export.destination_directory,
            evidence_index: targetOperation.evidence_index,
          });
        }
        return createComposedWorldEvidenceReceipt({
          export_handle: handle.parse(targetOperation.result_handle),
          inventory: worldInventoryFromTargetExport(targetOperation, evidenceHandle),
          pause_receipt_digest: pause.receipt_digest,
          run_id: journal.request.run_id,
          source_service_handle: parseComposedWorldServiceReceipt(
            composedPhasePayload(journal, "world_started_paused").receipt,
          ).service_handle,
          target_operation: targetOperation,
        });
      },
    },
    organization_finalization: {
      exportOrganizationEvidence: async ({ deployment_name, lifecycle_invocation_id, signal }) => {
        if (lifecycle_invocation_id !== provider.lifecycle_invocations.export) {
          throw new TypeError("organization export lifecycle invocation is not durable");
        }
        await guard();
        return runSpawnfileArtifactsExport(cli, {
          compiledOutputDirectory: provider.compiled_output_directory,
          deploymentName: deployment_name,
          destinationDirectory: provider.evidence_destination_directory,
          lifecycleInvocationId: lifecycle_invocation_id,
          orgPath: provider.organization_path,
          signal,
        });
      },
    },
    cleanup: {
      performCleanupOperation: async (operationInput) => {
        const journal = await load();
        const prepared = record(composedPhasePayload(journal, "prepared").preparation);
        const resources = record(prepared.resources);
        const organization = record(composedPhasePayload(journal, "organization_started").up_receipt);
        const attachment = parseTargetResourceReceipt(organization.target_attachment);
        const service = parseComposedWorldServiceReceipt(
          composedPhasePayload(journal, "world_started_paused").receipt,
        );
        if (operationInput.operation === "detach_organization") {
          const request = mutation(journal, "detach_organization", operationInput.idempotency_key, 10, {
            data_network_handle: record(resources.data_network).result_handle,
            organization_attachment_handle: attachment.result_handle,
          });
          verifyTargetResourceReceipt({
            operation: "detach_organization", raw: await runTarget("detach_organization", request, operationInput.signal),
            request, resulting_revision: 11, run_id: journal.request.run_id,
          });
        } else if (operationInput.operation === "down_organization") {
          await guard();
          const down = await runSpawnfileDown(cli, {
            compiledOutputDirectory: provider.compiled_output_directory,
            deploymentName: execution.configuration.organization_expectation.deployment_name,
            lifecycleInvocationId: provider.lifecycle_invocations.down,
            orgPath: provider.organization_path,
            removeVolumes: true,
            signal: operationInput.signal,
          });
          if (down.deployment !== execution.configuration.organization_expectation.deployment_name
            || down.errors.length > 0) throw new TypeError("organization down correlation is invalid");
        } else if (operationInput.operation === "revoke_secret_bindings") {
          const request = mutation(journal, "revoke_secret_bindings", operationInput.idempotency_key, 11, {
            secret_bindings_handle: record(resources.secret_bindings).result_handle,
          });
          verifyTargetResourceReceipt({
            operation: "revoke_secret_bindings", raw: await runTarget("revoke_secret_bindings", request, operationInput.signal),
            request, resulting_revision: 12, run_id: journal.request.run_id,
          });
        } else if (operationInput.operation === "cleanup_target_resources") {
          const request = mutation(journal, "cleanup_run", operationInput.idempotency_key, 12, {
            cleanup_policy: "remove",
            evidence_volume_handle: record(resources.evidence_volume).result_handle,
            organization_attachment_handle: attachment.result_handle,
            secret_bindings_handle: record(resources.secret_bindings).result_handle,
            world_service_handle: service.service_handle,
          });
          const cleaned = verifyTargetResourceReceipt({
            operation: "cleanup_run", raw: await runTarget("cleanup_run", request, operationInput.signal),
            request, resulting_revision: 13, run_id: journal.request.run_id,
          });
          if (cleaned.cleanup_state !== "removed") {
            throw new TypeError("target cleanup is incomplete");
          }
        }
        const released = operationInput.operation === "stop_world"
          ? [] : [...operationInput.target_handles];
        return createComposedCleanupOperationReceipt({
          operation: operationInput.operation,
          ownership_digest: operationInput.ownership_digest,
          released_handles: released,
          remaining_owned_handles: operationInput.owned_handles.filter(
            (owned) => !released.includes(owned),
          ),
          run_id: journal.request.run_id,
          state: "completed",
          target_handles: [...operationInput.target_handles],
        });
      },
    },
  };
};
