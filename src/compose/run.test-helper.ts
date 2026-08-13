import {
  createComposedTopologyActivationReceipt,
  createComposedTopologyAttestationReceipt,
  createComposedWorldTickReceipt,
} from "./activation.js";
import { createComposedCleanupOperationReceipt } from "./cleanup.js";
import { createComposedWorldEvidenceReceipt, createComposedWorldPauseReceipt } from "./finalize-world.js";
import { digestComposedJson } from "./json.js";
import {
  lifecycleDigest,
  lifecycleHandle,
  lifecycleOrganizationExpectation,
  lifecycleOrganizationUpReceipt,
  lifecyclePreparation,
  lifecycleReadiness,
  lifecycleReadinessExpectation,
} from "./lifecycle.test-helper.js";
import type { ComposedRunRequest } from "./request.js";
import type { ComposedRunConfiguration, ComposedRunPorts } from "./run.js";
import {
  createComposedWorldResourceReceipt,
  createComposedWorldServiceReceipt,
} from "./startup-world.js";
import { createComposedWorldTerminalReceipt } from "./supervision.js";

export type ComposedHarnessMutation = Readonly<{
  activation?: (value: unknown) => unknown;
  cleanup?: (value: unknown) => unknown;
  organization_evidence?: (value: unknown) => unknown;
  preparation?: (value: unknown) => unknown;
  terminal?: (value: unknown) => unknown;
  world_evidence?: (value: unknown) => unknown;
}>;

export interface ComposedHarnessTelemetry {
  readonly calls: string[];
  readonly cleanup_targets: string[];
  readonly effect_counts: Record<string, number>;
  activation_publications: number;
  participant_actions: number;
}

const organizationExport = (request: ComposedRunRequest) => ({
  deployment: "organization-unit",
  failed_files: [],
  index: {
    deployment: "organization-unit",
    exported_at: "2026-01-01T00:00:14.000Z",
    files: [
      { bytes: 1, path: "raw/daimon/member/log.jsonl", sha256: "a".repeat(64), source: { kind: "volume", ref: "d:/log" } },
      { bytes: 1, path: "raw/mneme/bank/log.jsonl", sha256: "b".repeat(64), source: { kind: "volume", ref: "m:/log" } },
      { bytes: 1, path: "raw/moltnet/log.jsonl", sha256: "c".repeat(64), source: { kind: "volume", ref: "n:/log" } },
    ],
    run_id: request.run_id,
    version: "spawnfile.export-index.v1",
  },
  index_path: "/evidence/spawnfile/export-index.json",
  missing_optional_files: [],
});

const mutate = (operation: ((value: unknown) => unknown) | undefined, value: unknown): unknown =>
  operation?.(value) ?? value;

/** Builds one deterministic, zero-agent, isolated target for composed-run integration tests. */
export const createComposedRunHarness = (
  request: ComposedRunRequest,
  mutation: ComposedHarnessMutation = {},
): Readonly<{
  configuration: ComposedRunConfiguration;
  ports: ComposedRunPorts;
  telemetry: ComposedHarnessTelemetry;
}> => {
  const organizationExpectation = lifecycleOrganizationExpectation();
  const topologyExpectation = {
    selected_target: {
      fingerprint: `sha256:${"1".repeat(32)}`,
      handle: lifecycleHandle("6"),
    },
    topology_request_digest: lifecycleDigest("7"),
  };
  const configuration: ComposedRunConfiguration = {
    deployment_name: "organization-unit",
    organization_expectation: organizationExpectation,
    readiness_expectation: lifecycleReadinessExpectation(request),
    terminal_tick: 4,
    topology_expectation: topologyExpectation,
  };
  const telemetry: ComposedHarnessTelemetry = {
    activation_publications: 0,
    calls: [],
    cleanup_targets: [],
    effect_counts: {},
    participant_actions: 0,
  };
  const effects = new Set<string>();
  const effect = (name: string, key: string): void => {
    const identity = `${name}:${key}`;
    if (effects.has(identity)) return;
    effects.add(identity);
    telemetry.effect_counts[name] = (telemetry.effect_counts[name] ?? 0) + 1;
  };
  let activated = false;
  let worldPhaseDigest: string | undefined;
  const preparation = lifecyclePreparation(request);
  const resource = createComposedWorldResourceReceipt({
    artifact_digest: request.world.artifact_manifest_digest,
    bundle_digest: request.world.bundle_digest,
    preparation_receipt_digest: preparation.receipt_digest,
    resource_handle: lifecycleHandle("2"),
    run_id: request.run_id,
  });
  const service = createComposedWorldServiceReceipt({
    resource_handle: resource.resource_handle,
    run_id: request.run_id,
    service_handle: lifecycleHandle("3"),
  });
  const ports: ComposedRunPorts = {
    cleanup: {
      performCleanupOperation: async (input) => {
        telemetry.calls.push(`cleanup:${input.operation}`);
        telemetry.cleanup_targets.push(...input.target_handles);
        effect(`cleanup:${input.operation}`, input.idempotency_key);
        const released = input.operation === "stop_world" ? [] : [...input.target_handles];
        const receipt = createComposedCleanupOperationReceipt({
          operation: input.operation,
          ownership_digest: input.ownership_digest,
          released_handles: released.sort(),
          remaining_owned_handles: input.owned_handles
            .filter((handle) => !released.includes(handle)).sort(),
          run_id: input.run_id,
          state: "completed",
          target_handles: [...input.target_handles].sort(),
        });
        return mutate(mutation.cleanup, receipt);
      },
    },
    organization: {
      readOrganizationReadiness: async () => {
        telemetry.calls.push("organization:ready");
        return lifecycleOrganizationUpReceipt(request.run_id, true);
      },
      startOrganization: async (input) => {
        telemetry.calls.push("organization:start");
        effect("organization:start", input.idempotency_key);
        return lifecycleOrganizationUpReceipt(request.run_id, false);
      },
    },
    organization_finalization: {
      exportOrganizationEvidence: async (input) => {
        telemetry.calls.push("organization:export");
        effect("organization:export", input.lifecycle_invocation_id);
        return mutate(mutation.organization_evidence, organizationExport(request));
      },
    },
    preparation: {
      prepareComposedRun: async (input) => {
        telemetry.calls.push("target:prepare");
        effect("target:prepare", input.idempotency_key);
        return mutate(mutation.preparation, preparation);
      },
    },
    supervision: {
      waitForWorldTerminal: async (input) => {
        telemetry.calls.push("world:terminal");
        return mutate(mutation.terminal, createComposedWorldTerminalReceipt({
          outcome_digest: lifecycleDigest("0"),
          reason: "completed",
          run_id: request.run_id,
          running_receipt_digest: input.running.receipt_digest,
          terminal_tick: input.expected_terminal_tick,
        }));
      },
    },
    topology: {
      activateTopology: async (input) => {
        telemetry.calls.push("topology:activate");
        effect("topology:activate", input.idempotency_key);
        activated = true;
        telemetry.activation_publications = telemetry.effect_counts["topology:activate"] ?? 0;
        const topology = input.attestation.target_topology;
        const marker = {
          bundle_digest: request.world.artifact_manifest_digest,
          run_id: request.run_id,
          state: "activated" as const,
          topology_receipt_digest: topology.receipt_digest,
          topology_request_digest: topology.request_digest,
          version: "spawnfile.world-service-activation.v1" as const,
        };
        const body = {
          activation_digest: digestComposedJson("spawnfile.world-service-activation.v1", marker),
          bundle_digest: marker.bundle_digest,
          run_id: marker.run_id,
          state: marker.state,
          topology_receipt_digest: marker.topology_receipt_digest,
          topology_request_digest: marker.topology_request_digest,
          version: "spawnfile.target-topology-activation-receipt.v1" as const,
        };
        const receipt = createComposedTopologyActivationReceipt({
          attestation_receipt_digest: input.attestation.receipt_digest,
          run_id: request.run_id,
          target_activation: {
            ...body,
            receipt_digest: digestComposedJson(
              "spawnfile.target-topology-activation-receipt.v1", body,
            ),
          },
        });
        return mutate(mutation.activation, receipt);
      },
      attestTopology: async (input) => {
        telemetry.calls.push("topology:attest");
        worldPhaseDigest = input.world_phase_digest;
        const body = {
          descriptor_digest: request.descriptor_digest,
          handoff_scope: "organization_to_private_service" as const,
          organization: {
            data_network_attachment: "exact" as const,
            egress_policy: "egress_only" as const,
          },
          request_digest: input.topology_request_digest,
          run_id: request.run_id,
          selected_target: topologyExpectation.selected_target,
          service_discovery: "dns_only" as const,
          version: "spawnfile.target-topology-receipt.v1" as const,
          world_network: "private_internal" as const,
          world_service: {
            data_network_attachment: "exactly_one" as const,
            egress_policy: "none" as const,
            published_ports: "none" as const,
          },
        };
        return createComposedTopologyAttestationReceipt({
          organization_phase_digest: input.organization_phase_digest,
          request_digest: input.request_digest,
          run_id: input.run_id,
          target_topology: {
            ...body,
            receipt_digest: digestComposedJson("spawnfile.target-topology-receipt.v1", body),
          },
          world_phase_digest: input.world_phase_digest,
        });
      },
      readFirstTick: async (input) => {
        telemetry.calls.push("world:tick-1");
        if (!activated || worldPhaseDigest === undefined) {
          throw new Error("clock is paused before activation");
        }
        return createComposedWorldTickReceipt({
          activation_receipt_digest: input.activation.receipt_digest,
          clock: { completed_tick: 1, next_tick: 2, state: "running" },
          run_id: request.run_id,
          world_phase_digest: worldPhaseDigest,
        });
      },
    },
    world: {
      createWorldResource: async (input) => {
        telemetry.calls.push("world:create");
        effect("world:create", input.idempotency_key);
        return resource;
      },
      readWorldReadiness: async () => {
        telemetry.calls.push("world:ready");
        return lifecycleReadiness(request);
      },
      startWorldPaused: async (input) => {
        telemetry.calls.push("world:start-paused");
        effect("world:start-paused", input.idempotency_key);
        return service;
      },
    },
    world_finalization: {
      exportWorldEvidence: async (input) => {
        telemetry.calls.push("world:export");
        effect("world:export", input.idempotency_key);
        const receipt = createComposedWorldEvidenceReceipt({
          export_handle: lifecycleHandle("7"),
          inventory: [
            { authority: "actions", bytes: 1, path: "actions/log.jsonl", sha256: lifecycleDigest("a") },
            { authority: "checkpoints", bytes: 2, path: "checkpoints/final.json", sha256: lifecycleDigest("b") },
            { authority: "projections", bytes: 3, path: "projections/world.json", sha256: lifecycleDigest("c") },
          ],
          pause_receipt_digest: input.pause.receipt_digest,
          run_id: request.run_id,
          source_service_handle: service.service_handle,
        });
        return mutate(mutation.world_evidence, receipt);
      },
      pauseWorld: async (input) => {
        telemetry.calls.push("world:pause");
        effect("world:pause", input.idempotency_key);
        return createComposedWorldPauseReceipt({
          final_tick: input.terminal.terminal_tick,
          run_id: request.run_id,
          service_handle: service.service_handle,
          terminal_receipt_digest: input.terminal.receipt_digest,
        });
      },
    },
  };
  return { configuration, ports, telemetry };
};
