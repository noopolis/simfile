import {
  createComposedTopologyActivationReceipt,
  createComposedTopologyAttestationReceipt,
  createComposedWorldTickReceipt,
} from "../compose/activation.js";
import type { ComposedExecution } from "../compose/execution.js";
import { composedPhasePayload } from "../compose/phase.js";
import type { ComposedRunPorts } from "../compose/run.js";
import { parseComposedWorldServiceReceipt } from "../compose/startup-world.js";
import {
  createProductionTargetDriver,
  productionRecord as record,
} from "./productionTarget.js";
import { verifyTargetWorldClockReceipt } from "./targetReceipts.js";

type Driver = ReturnType<typeof createProductionTargetDriver>;

export const createProductionTopologyPort = (
  execution: ComposedExecution,
  driver: Driver,
): ComposedRunPorts["topology"] => {
  const provider = execution.provider;
  const { load, runTarget, selectedTarget, topologyRequest } = driver;
  return {
    attestTopology: async ({ organization_phase_digest, request_digest, signal,
      world_phase_digest }) => {
      const request = await topologyRequest();
      return createComposedTopologyAttestationReceipt({ organization_phase_digest,
        request_digest, run_id: request.run_id,
        target_topology: await runTarget("attest_topology", request, signal) as never,
        world_phase_digest });
    },
    activateTopology: async ({ attestation, signal }) => {
      const request = await topologyRequest();
      return createComposedTopologyActivationReceipt({
        attestation_receipt_digest: attestation.receipt_digest, run_id: request.run_id,
        target_activation: await runTarget("activate_topology", request, signal) as never,
      });
    },
    readFirstTick: async ({ activation, signal }) => {
      const journal = await load();
      const service = parseComposedWorldServiceReceipt(
        composedPhasePayload(journal, "world_started_paused").receipt,
      );
      const topology = record(record(
        composedPhasePayload(journal, "topology_verified").attestation,
      ).target_topology);
      const targetActivation = activation.target_activation;
      const request = {
        activation_digest: targetActivation.activation_digest,
        activation_receipt_digest: targetActivation.receipt_digest,
        descriptor_digest: journal.request.descriptor_digest,
        endpoint: { internal_port: provider.world_readiness_port, path: "/v1/world/clock" },
        expected: { document_version: "simfile.world-sidecar-clock.v1",
          world_instance_id: execution.configuration.readiness_expectation.world_instance_id },
        run_id: journal.request.run_id, selected_target: selectedTarget,
        topology_receipt_digest: topology.receipt_digest,
        topology_request_digest: topology.request_digest,
        version: "spawnfile.target-world-clock.request.v1",
        world_service_handle: service.service_handle,
      } as const;
      const observed = verifyTargetWorldClockReceipt({
        raw: await runTarget("query_world_clock", request, signal), request,
      });
      return createComposedWorldTickReceipt({
        activation_receipt_digest: activation.receipt_digest, clock: observed.clock,
        run_id: journal.request.run_id,
        world_phase_digest: journal.entries.find(
          ({ phase }) => phase === "world_ready",
        )!.payload_digest,
      });
    },
  };
};
