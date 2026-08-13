import { z } from "zod";

import {
  composedDigestSchema,
  composedHandleSchema,
  composedRunIdSchema,
  parseComposedDigestedContract,
  sealComposedContract,
} from "./contracts.js";
import { digestComposedJson } from "./json.js";
import { parseComposedPhaseJournal, type ComposedPhaseJournal } from "./journal.js";
import {
  commitComposedPhase,
  composedPhasePayload,
  composedPhaseReached,
  type ComposedPhaseContext,
} from "./phase.js";
import { composedRunPhaseIndex } from "./types.js";
import { parseWorldSidecarReadiness } from "../world-artifact/readiness.js";

export const COMPOSED_TOPOLOGY_ATTESTATION_VERSION =
  "simfile.composed-topology-attestation.v1" as const;
export const COMPOSED_TOPOLOGY_ACTIVATION_VERSION =
  "simfile.composed-topology-activation.v1" as const;
export const COMPOSED_WORLD_TICK_VERSION = "simfile.composed-world-tick.v1" as const;

const selectedTarget = z.object({
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{32}$/u),
  handle: composedHandleSchema,
}).strict();
const targetTopology = z.object({
  descriptor_digest: composedDigestSchema,
  handoff_scope: z.literal("organization_to_private_service"),
  organization: z.object({
    data_network_attachment: z.literal("exact"),
    egress_policy: z.literal("egress_only"),
  }).strict(),
  receipt_digest: composedDigestSchema,
  request_digest: composedDigestSchema,
  run_id: composedRunIdSchema,
  selected_target: selectedTarget,
  service_discovery: z.literal("dns_only"),
  version: z.literal("spawnfile.target-topology-receipt.v1"),
  world_network: z.literal("private_internal"),
  world_service: z.object({
    data_network_attachment: z.literal("exactly_one"),
    egress_policy: z.literal("none"),
    published_ports: z.literal("none"),
  }).strict(),
}).strict();
const targetActivation = z.object({
  activation_digest: composedDigestSchema,
  bundle_digest: composedDigestSchema,
  receipt_digest: composedDigestSchema,
  run_id: composedRunIdSchema,
  state: z.literal("activated"),
  topology_receipt_digest: composedDigestSchema,
  topology_request_digest: composedDigestSchema,
  version: z.literal("spawnfile.target-topology-activation-receipt.v1"),
}).strict();

const attestationSchema = z.object({
  organization_phase_digest: composedDigestSchema,
  receipt_digest: composedDigestSchema,
  request_digest: composedDigestSchema,
  run_id: composedRunIdSchema,
  target_topology: targetTopology,
  version: z.literal(COMPOSED_TOPOLOGY_ATTESTATION_VERSION),
  world_phase_digest: composedDigestSchema,
}).strict();
const activationSchema = z.object({
  attestation_receipt_digest: composedDigestSchema,
  receipt_digest: composedDigestSchema,
  run_id: composedRunIdSchema,
  target_activation: targetActivation,
  version: z.literal(COMPOSED_TOPOLOGY_ACTIVATION_VERSION),
}).strict();
const tickSchema = z.object({
  activation_receipt_digest: composedDigestSchema,
  clock: z.object({
    completed_tick: z.number().int().min(1).max(1_000_000_000),
    next_tick: z.number().int().min(2).max(1_000_000_001),
    state: z.literal("running"),
  }).strict().superRefine((value, context) => {
    if (value.next_tick !== value.completed_tick + 1) context.addIssue({
      code: z.ZodIssueCode.custom, message: "composed world tick frontier is invalid",
    });
  }),
  receipt_digest: composedDigestSchema,
  run_id: composedRunIdSchema,
  version: z.literal(COMPOSED_WORLD_TICK_VERSION),
  world_phase_digest: composedDigestSchema,
}).strict();

export type ComposedTopologyAttestationReceipt = z.infer<typeof attestationSchema>;
export type ComposedTopologyActivationReceipt = z.infer<typeof activationSchema>;
export type ComposedWorldTickReceipt = z.infer<typeof tickSchema>;
export type TargetTopologyReceipt = z.infer<typeof targetTopology>;
export type TargetTopologyActivationReceipt = z.infer<typeof targetActivation>;

const verifyTargetTopology = (value: TargetTopologyReceipt): void => {
  const { receipt_digest: _receiptDigest, ...body } = value;
  if (value.receipt_digest !== digestComposedJson("spawnfile.target-topology-receipt.v1", body)) {
    throw new TypeError("target topology receipt digest is invalid");
  }
};

const verifyTargetActivation = (value: TargetTopologyActivationReceipt): void => {
  const { receipt_digest: _receiptDigest, ...body } = value;
  if (value.receipt_digest !== digestComposedJson(
    "spawnfile.target-topology-activation-receipt.v1", body,
  )) throw new TypeError("target topology activation receipt digest is invalid");
  const marker = {
    bundle_digest: value.bundle_digest,
    run_id: value.run_id,
    state: value.state,
    topology_receipt_digest: value.topology_receipt_digest,
    topology_request_digest: value.topology_request_digest,
    version: "spawnfile.world-service-activation.v1",
  };
  if (value.activation_digest !== digestComposedJson(
    "spawnfile.world-service-activation.v1", marker,
  )) throw new TypeError("target world activation digest is invalid");
};

export const parseComposedTopologyAttestationReceipt = (
  raw: unknown,
): ComposedTopologyAttestationReceipt => {
  const value = parseComposedDigestedContract(raw, attestationSchema,
    COMPOSED_TOPOLOGY_ATTESTATION_VERSION, "composed topology attestation receipt");
  verifyTargetTopology(value.target_topology);
  return value;
};
export const createComposedTopologyAttestationReceipt = (
  body: Omit<ComposedTopologyAttestationReceipt, "receipt_digest" | "version">,
): ComposedTopologyAttestationReceipt => parseComposedTopologyAttestationReceipt(
  sealComposedContract(COMPOSED_TOPOLOGY_ATTESTATION_VERSION, {
    ...body, version: COMPOSED_TOPOLOGY_ATTESTATION_VERSION,
  }),
);
export const parseComposedTopologyActivationReceipt = (
  raw: unknown,
): ComposedTopologyActivationReceipt => {
  const value = parseComposedDigestedContract(raw, activationSchema,
    COMPOSED_TOPOLOGY_ACTIVATION_VERSION, "composed topology activation receipt");
  verifyTargetActivation(value.target_activation);
  return value;
};
export const createComposedTopologyActivationReceipt = (
  body: Omit<ComposedTopologyActivationReceipt, "receipt_digest" | "version">,
): ComposedTopologyActivationReceipt => parseComposedTopologyActivationReceipt(
  sealComposedContract(COMPOSED_TOPOLOGY_ACTIVATION_VERSION, {
    ...body, version: COMPOSED_TOPOLOGY_ACTIVATION_VERSION,
  }),
);
export const parseComposedWorldTickReceipt = (raw: unknown): ComposedWorldTickReceipt =>
  parseComposedDigestedContract(raw, tickSchema,
    COMPOSED_WORLD_TICK_VERSION, "composed world tick receipt");
export const createComposedWorldTickReceipt = (
  body: Omit<ComposedWorldTickReceipt, "receipt_digest" | "version">,
): ComposedWorldTickReceipt => parseComposedWorldTickReceipt(
  sealComposedContract(COMPOSED_WORLD_TICK_VERSION, {
    ...body, version: COMPOSED_WORLD_TICK_VERSION,
  }),
);

export interface ComposedTopologyExpectation {
  readonly selected_target: Readonly<{ fingerprint: string; handle: string }>;
  readonly topology_request_digest?: string;
}

export interface ComposedTopologyActivationPort {
  attestTopology(input: Readonly<{
    organization_phase: Readonly<Record<string, unknown>>;
    organization_phase_digest: string;
    request_digest: string;
    run_id: string;
    topology_request_digest: string;
    signal: AbortSignal;
    world_phase: Readonly<Record<string, unknown>>;
    world_phase_digest: string;
  }>): Promise<unknown>;
  activateTopology(input: Readonly<{
    attestation: ComposedTopologyAttestationReceipt;
    idempotency_key: string;
    signal: AbortSignal;
  }>): Promise<unknown>;
  readFirstTick(input: Readonly<{
    activation: ComposedTopologyActivationReceipt;
    signal: AbortSignal;
  }>): Promise<unknown>;
}

const phaseDigest = (journal: ComposedPhaseJournal, phase: "world_ready" | "organization_ready") =>
  journal.entries[composedRunPhaseIndex(phase)]!.payload_digest;
const operationKey = (journal: ComposedPhaseJournal): string =>
  `idem_${digestComposedJson("simfile.composed-topology-operation.v1", {
    operation: "activate_topology", request_digest: journal.request_digest,
  }).slice(7, 39)}`;
const sameTarget = (left: TargetTopologyReceipt["selected_target"], right: ComposedTopologyExpectation["selected_target"]): boolean =>
  left.fingerprint === right.fingerprint && left.handle === right.handle;

const verifyAttestation = (
  raw: unknown,
  journal: ComposedPhaseJournal,
  expectation: ComposedTopologyExpectation,
): ComposedTopologyAttestationReceipt => {
  const receipt = parseComposedTopologyAttestationReceipt(raw);
  const topology = receipt.target_topology;
  if (receipt.run_id !== journal.request.run_id
    || receipt.request_digest !== journal.request_digest
    || receipt.world_phase_digest !== phaseDigest(journal, "world_ready")
    || receipt.organization_phase_digest !== phaseDigest(journal, "organization_ready")
    || topology.run_id !== journal.request.run_id
    || topology.descriptor_digest !== journal.request.descriptor_digest
    || (expectation.topology_request_digest !== undefined
      && topology.request_digest !== expectation.topology_request_digest)
    || !sameTarget(topology.selected_target, expectation.selected_target)) {
    throw new TypeError("composed topology attestation correlation is invalid");
  }
  return receipt;
};

const verifyActivation = (
  raw: unknown,
  journal: ComposedPhaseJournal,
  attestation: ComposedTopologyAttestationReceipt,
): ComposedTopologyActivationReceipt => {
  const receipt = parseComposedTopologyActivationReceipt(raw);
  const activation = receipt.target_activation;
  if (receipt.run_id !== journal.request.run_id
    || receipt.attestation_receipt_digest !== attestation.receipt_digest
    || activation.run_id !== journal.request.run_id
    || activation.bundle_digest !== journal.request.world.artifact_manifest_digest
    || activation.topology_request_digest !== attestation.target_topology.request_digest
    || activation.topology_receipt_digest !== attestation.target_topology.receipt_digest) {
    throw new TypeError("composed topology activation correlation is invalid");
  }
  return receipt;
};

/** Attests both owners, publishes one activation, then observes clock tick 1. */
export const activateComposedTopology = async (input: Readonly<{
  context: ComposedPhaseContext;
  expectation: ComposedTopologyExpectation;
  journal: unknown;
  port: ComposedTopologyActivationPort;
  signal?: AbortSignal;
}>): Promise<ComposedPhaseJournal> => {
  let journal = parseComposedPhaseJournal(input.journal);
  if (!composedPhaseReached(journal, "organization_ready")) {
    throw new TypeError("composed activation requires both owners ready");
  }
  const readiness = parseWorldSidecarReadiness(
    composedPhasePayload(journal, "world_ready").readiness,
  );
  const advertised = new Map((readiness.capabilities ?? []).map((entry) => [
    entry.identity, entry.manifest_digest,
  ]));
  if (journal.request.required_world_capabilities.some((identity) => {
    const manifest = advertised.get(identity);
    return manifest === undefined || !readiness.capability_manifest_digests.includes(manifest);
  })) {
    throw new TypeError("composed activation requires world-attested capabilities");
  }
  if (!composedPhaseReached(journal, "topology_verified")) {
    const worldPhase = composedPhasePayload(journal, "world_ready");
    const organizationPhase = composedPhasePayload(journal, "organization_ready");
    const topologyRequestDigest = input.expectation.topology_request_digest
      ?? digestComposedJson("simfile.composed-topology-request-hint.v1", {
        organization_phase_digest: phaseDigest(journal, "organization_ready"),
        request_digest: journal.request_digest,
        world_phase_digest: phaseDigest(journal, "world_ready"),
      });
    const receipt = verifyAttestation(await input.port.attestTopology({
      organization_phase: organizationPhase,
      organization_phase_digest: phaseDigest(journal, "organization_ready"),
      request_digest: journal.request_digest,
      run_id: journal.request.run_id,
      topology_request_digest: topologyRequestDigest,
      signal: input.signal ?? new AbortController().signal,
      world_phase: worldPhase,
      world_phase_digest: phaseDigest(journal, "world_ready"),
    }), journal, input.expectation);
    journal = await commitComposedPhase(journal, "topology_verified", {
      attestation: receipt, receipt_digest: receipt.receipt_digest, run_id: journal.request.run_id,
    }, input.context);
  }
  const attestation = verifyAttestation(
    composedPhasePayload(journal, "topology_verified").attestation, journal, input.expectation,
  );
  if (!composedPhaseReached(journal, "activated")) {
    const receipt = verifyActivation(await input.port.activateTopology({
      attestation, idempotency_key: operationKey(journal),
      signal: input.signal ?? new AbortController().signal,
    }), journal, attestation);
    journal = await commitComposedPhase(journal, "activated", {
      activation: receipt, receipt_digest: receipt.receipt_digest, run_id: journal.request.run_id,
    }, input.context);
  }
  const activation = verifyActivation(
    composedPhasePayload(journal, "activated").activation, journal, attestation,
  );
  if (!composedPhaseReached(journal, "tick_1")) {
    const tick = parseComposedWorldTickReceipt(await input.port.readFirstTick({
      activation, signal: input.signal ?? new AbortController().signal,
    }));
    if (tick.run_id !== journal.request.run_id
      || tick.activation_receipt_digest !== activation.receipt_digest
      || tick.world_phase_digest !== phaseDigest(journal, "world_ready")) {
      throw new TypeError("composed first tick correlation is invalid");
    }
    journal = await commitComposedPhase(journal, "tick_1", {
      receipt: tick, receipt_digest: tick.receipt_digest, run_id: journal.request.run_id,
    }, input.context);
  }
  return journal;
};
