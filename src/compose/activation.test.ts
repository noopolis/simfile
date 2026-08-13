import assert from "node:assert/strict";
import test from "node:test";

import {
  activateComposedTopology,
  createComposedTopologyActivationReceipt,
  createComposedTopologyAttestationReceipt,
  createComposedWorldTickReceipt,
  type ComposedTopologyActivationPort,
  type ComposedTopologyExpectation,
} from "./activation.js";
import { digestComposedJson } from "./json.js";
import type { ComposedPhaseJournal } from "./journal.js";
import {
  lifecycleDigest,
  lifecycleHandle,
  lifecyclePhaseContext,
  lifecycleRequest,
  organizationReadyLifecycleJournal,
  worldReadyLifecycleJournal,
} from "./lifecycle.test-helper.js";
import { composedRunPhaseIndex } from "./types.js";

const expectation = (): ComposedTopologyExpectation => ({
  selected_target: {
    fingerprint: `sha256:${"1".repeat(32)}`,
    handle: lifecycleHandle("6"),
  },
  topology_request_digest: lifecycleDigest("7"),
});

const phaseDigest = (
  journal: ComposedPhaseJournal,
  phase: "world_ready" | "organization_ready",
): string => journal.entries[composedRunPhaseIndex(phase)]!.payload_digest;

const targetTopology = (
  journal: ComposedPhaseJournal,
  expected = expectation(),
) => {
  const body = {
    descriptor_digest: journal.request.descriptor_digest,
    handoff_scope: "organization_to_private_service" as const,
    organization: {
      data_network_attachment: "exact" as const,
      egress_policy: "egress_only" as const,
    },
    request_digest: expected.topology_request_digest ?? lifecycleDigest("7"),
    run_id: journal.request.run_id,
    selected_target: expected.selected_target,
    service_discovery: "dns_only" as const,
    version: "spawnfile.target-topology-receipt.v1" as const,
    world_network: "private_internal" as const,
    world_service: {
      data_network_attachment: "exactly_one" as const,
      egress_policy: "none" as const,
      published_ports: "none" as const,
    },
  };
  return {
    ...body,
    receipt_digest: digestComposedJson("spawnfile.target-topology-receipt.v1", body),
  };
};

type Mutation = Readonly<{
  activation?: (value: unknown) => unknown;
  attestation?: (value: unknown) => unknown;
  tick?: (value: unknown) => unknown;
}>;

const fakePort = (
  journal: ComposedPhaseJournal,
  expected = expectation(),
  mutation: Mutation = {},
) => {
  const calls = { activate: 0, attest: 0, published: 0, tick: 0 };
  let activated = false;
  const publicationKeys = new Set<string>();
  const port: ComposedTopologyActivationPort = {
    activateTopology: async ({ attestation, idempotency_key }) => {
      calls.activate += 1;
      if (!publicationKeys.has(idempotency_key)) {
        publicationKeys.add(idempotency_key);
        calls.published += 1;
        activated = true;
      }
      const topology = attestation.target_topology;
      const marker = {
        bundle_digest: journal.request.world.artifact_manifest_digest,
        run_id: journal.request.run_id,
        state: "activated" as const,
        topology_receipt_digest: topology.receipt_digest,
        topology_request_digest: topology.request_digest,
        version: "spawnfile.world-service-activation.v1" as const,
      };
      const activationBody = {
        activation_digest: digestComposedJson("spawnfile.world-service-activation.v1", marker),
        bundle_digest: marker.bundle_digest,
        run_id: marker.run_id,
        state: marker.state,
        topology_receipt_digest: marker.topology_receipt_digest,
        topology_request_digest: marker.topology_request_digest,
        version: "spawnfile.target-topology-activation-receipt.v1" as const,
      };
      const target = {
        ...activationBody,
        receipt_digest: digestComposedJson(
          "spawnfile.target-topology-activation-receipt.v1", activationBody,
        ),
      };
      const receipt = createComposedTopologyActivationReceipt({
        attestation_receipt_digest: attestation.receipt_digest,
        run_id: journal.request.run_id,
        target_activation: target,
      });
      return mutation.activation?.(receipt) ?? receipt;
    },
    attestTopology: async (input) => {
      calls.attest += 1;
      const receipt = createComposedTopologyAttestationReceipt({
        organization_phase_digest: input.organization_phase_digest,
        request_digest: input.request_digest,
        run_id: input.run_id,
        target_topology: targetTopology(journal, expected),
        world_phase_digest: input.world_phase_digest,
      });
      return mutation.attestation?.(receipt) ?? receipt;
    },
    readFirstTick: async ({ activation }) => {
      calls.tick += 1;
      if (!activated) throw new Error("clock remains paused before activation");
      const receipt = createComposedWorldTickReceipt({
        activation_receipt_digest: activation.receipt_digest,
        clock: { completed_tick: 1, next_tick: 2, state: "running" },
        run_id: journal.request.run_id,
        world_phase_digest: phaseDigest(journal, "world_ready"),
      });
      return mutation.tick?.(receipt) ?? receipt;
    },
  };
  return {
    attemptClaim: () => {
      if (!activated) throw new Error("claim authority is inactive");
    },
    calls,
    port,
  };
};

test("activation is atomic and tick 1 needs no participant action", async () => {
  const request = lifecycleRequest();
  const initial = organizationReadyLifecycleJournal(request);
  const fake = fakePort(initial);
  const participantActions = 0;
  assert.throws(fake.attemptClaim, /inactive/u);
  const journal = await activateComposedTopology({
    context: lifecyclePhaseContext().context,
    expectation: expectation(),
    journal: initial,
    port: fake.port,
  });
  assert.equal(journal.current_phase, "tick_1");
  assert.equal(participantActions, 0);
  assert.deepEqual(fake.calls, { activate: 1, attest: 1, published: 1, tick: 1 });
});

test("activation resumes every durable boundary without republishing", async () => {
  for (const failedPhase of ["topology_verified", "activated", "tick_1"] as const) {
    const request = lifecycleRequest({ run_id: `run-${failedPhase}` });
    const initial = organizationReadyLifecycleJournal(request);
    const fake = fakePort(initial);
    const persisted: ComposedPhaseJournal[] = [];
    await assert.rejects(activateComposedTopology({
      context: lifecyclePhaseContext({
        afterPhase: (phase) => {
          if (phase === failedPhase) throw new Error(`fault after ${phase}`);
        },
        persisted,
      }).context,
      expectation: expectation(),
      journal: initial,
      port: fake.port,
    }), /fault after/u);
    const resumed = await activateComposedTopology({
      context: lifecyclePhaseContext().context,
      expectation: expectation(),
      journal: persisted.at(-1),
      port: fake.port,
    });
    assert.equal(resumed.current_phase, "tick_1");
    assert.deepEqual(fake.calls, { activate: 1, attest: 1, published: 1, tick: 1 });
  }
});

test("activation rejects missing owner, stale, cross-run, partial, and forged proofs", async () => {
  const request = lifecycleRequest();
  const initial = organizationReadyLifecycleJournal(request);
  const run = (mutation: Mutation, expected = expectation()) => activateComposedTopology({
    context: lifecyclePhaseContext().context,
    expectation: expected,
    journal: initial,
    port: fakePort(initial, expectation(), mutation).port,
  });
  await assert.rejects(activateComposedTopology({
    context: lifecyclePhaseContext().context,
    expectation: expectation(),
    journal: worldReadyLifecycleJournal(request),
    port: fakePort(initial).port,
  }), /both owners/u);
  await assert.rejects(run({}, {
    ...expectation(), topology_request_digest: lifecycleDigest("8"),
  }), /correlation/u);
  await assert.rejects(run({ attestation: (raw) => {
    const { receipt_digest: _receiptDigest, ...body } = raw as ReturnType<
      typeof createComposedTopologyAttestationReceipt
    >;
    const forged = { ...body, world_phase_digest: lifecycleDigest("8") };
    return {
      ...forged,
      receipt_digest: digestComposedJson("simfile.composed-topology-attestation.v1", forged),
    };
  } }), /correlation/u);
  await assert.rejects(run({ attestation: (raw) => ({
    ...(raw as Record<string, unknown>), run_id: "run-foreign",
  }) }), /digest|correlation/u);
  await assert.rejects(run({ activation: () => ({ state: "activated" }) }), /expected|invalid/u);
  await assert.rejects(run({ activation: (raw) => ({
    ...(raw as Record<string, unknown>), receipt_digest: lifecycleDigest("9"),
  }) }), /digest/u);
  await assert.rejects(run({ tick: (raw) => ({
    ...(raw as Record<string, unknown>), clock: { completed_tick: 2, next_tick: 3, state: "running" },
  }) }), /expected|digest/u);
});

test("live activation accepts only a request carrying the declared claim extension", async () => {
  const request = lifecycleRequest({
    mode: "live",
    required_world_capabilities: ["simfile.world-decision-claim.v1"],
  });
  const initial = organizationReadyLifecycleJournal(request);
  const journal = await activateComposedTopology({
    context: lifecyclePhaseContext().context,
    expectation: expectation(),
    journal: initial,
    port: fakePort(initial).port,
  });
  assert.equal(journal.current_phase, "tick_1");
  assert.throws(() => lifecycleRequest({ mode: "live" }), /decision-claim/u);
  const unattested = organizationReadyLifecycleJournal(request, false);
  await assert.rejects(activateComposedTopology({
    context: lifecyclePhaseContext().context,
    expectation: expectation(),
    journal: unattested,
    port: fakePort(unattested).port,
  }), /world-attested capabilities/u);
});
