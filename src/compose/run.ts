import {
  parseSpawnfileComposedPreparationReceipt,
  type SpawnfileComposedPreparationReceipt,
} from "../spawnfile/preparationReceipt.js";
import {
  activateComposedTopology,
  parseComposedTopologyActivationReceipt,
  parseComposedTopologyAttestationReceipt,
  type ComposedTopologyActivationPort,
  type ComposedTopologyExpectation,
} from "./activation.js";
import { cleanupComposedRun, parseComposedCleanupReceipt, type ComposedCleanupPort } from "./cleanup.js";
import {
  finalizeComposedOrganization,
  parseComposedOrganizationEvidenceReceipt,
  type ComposedOrganizationFinalizationPort,
} from "./finalize-organization.js";
import {
  finalizeComposedWorld,
  parseComposedWorldPauseReceipt,
  parseComposedWorldEvidenceReceipt,
  type ComposedWorldFinalizationPort,
} from "./finalize-world.js";
import { digestComposedJson } from "./json.js";
import { parseComposedPhaseJournal, type ComposedPhaseJournal } from "./journal.js";
import {
  commitComposedPhase,
  composedPhasePayload,
  composedPhaseReached,
  type ComposedPhaseContext,
} from "./phase.js";
import {
  createComposedTerminalReceipt,
  type ComposedTerminalReceipt,
  verifyComposedTerminalReceipt,
} from "./receipt.js";
import type { ComposedRunRequest } from "./request.js";
import {
  startComposedOrganization,
  type ComposedOrganizationExpectation,
  type ComposedOrganizationStartupPort,
} from "./startup-organization.js";
import {
  startComposedWorld,
  parseComposedWorldServiceReceipt,
  type ComposedWorldStartupPort,
} from "./startup-world.js";
import {
  superviseComposedWorld,
  type ComposedSupervisionPort,
} from "./supervision.js";
import type { WorldSidecarReadinessExpectation } from "../world-artifact/readiness.js";
import { composedRunPhaseIndex } from "./types.js";

export interface ComposedPreparationPort {
  prepareComposedRun(input: Readonly<{
    idempotency_key: string;
    request: ComposedRunRequest;
    signal: AbortSignal;
  }>): Promise<unknown>;
}

export interface ComposedRunPorts {
  readonly cleanup: ComposedCleanupPort;
  readonly organization: ComposedOrganizationStartupPort;
  readonly organization_finalization: ComposedOrganizationFinalizationPort;
  readonly preparation: ComposedPreparationPort;
  readonly supervision: ComposedSupervisionPort;
  readonly topology: ComposedTopologyActivationPort;
  readonly world: ComposedWorldStartupPort;
  readonly world_finalization: ComposedWorldFinalizationPort;
}

export interface ComposedRunConfiguration {
  readonly deployment_name: string;
  readonly operator_timeout_ms?: number;
  readonly organization_expectation: ComposedOrganizationExpectation;
  readonly readiness_expectation: WorldSidecarReadinessExpectation;
  readonly terminal_tick: number;
  readonly topology_expectation: ComposedTopologyExpectation;
}

export interface CompletedComposedRun {
  readonly journal: ComposedPhaseJournal;
  readonly receipt: ComposedTerminalReceipt;
}

const terminalJournalDigest = (journal: ComposedPhaseJournal): string =>
  digestComposedJson("simfile.composed-terminal-journal.v1", {
    entries: journal.entries.slice(0, composedRunPhaseIndex("completed")),
    request_digest: journal.request_digest,
  });

export const completedComposedRunFromJournal = (raw: unknown): CompletedComposedRun => {
  const journal = parseComposedPhaseJournal(raw);
  if (journal.current_phase !== "completed") {
    throw new TypeError("composed journal is not complete");
  }
  return {
    journal,
    receipt: verifyComposedTerminalReceipt(
      composedPhasePayload(journal, "completed").receipt,
      journal.request,
      terminalJournalDigest(journal),
    ),
  };
};

const preparationKey = (journal: ComposedPhaseJournal): string =>
  `idem_${digestComposedJson("simfile.composed-preparation-operation.v1", {
    operation: "prepare_composed_run", request_digest: journal.request_digest,
  }).slice(7, 39)}`;

const verifyPreparation = (
  raw: unknown,
  journal: ComposedPhaseJournal,
  topology: ComposedTopologyExpectation,
): SpawnfileComposedPreparationReceipt => {
  const receipt = parseSpawnfileComposedPreparationReceipt(raw);
  if (receipt.run_id !== journal.request.run_id
    || receipt.descriptor_digest !== journal.request.descriptor_digest
    || receipt.auth_profile !== journal.request.target.auth_profile
    || receipt.target_selector !== journal.request.target.selector
    || receipt.organization.artifact_digest !== journal.request.organization.artifact_digest
    || receipt.organization.world_bindings_digest
      !== journal.request.organization.world_bindings_digest
    || receipt.world.artifact_manifest_digest !== journal.request.world.artifact_manifest_digest
    || receipt.world.bundle_digest !== journal.request.world.bundle_digest
    || receipt.selected_target.fingerprint !== topology.selected_target.fingerprint
    || receipt.selected_target.handle !== topology.selected_target.handle) {
    throw new TypeError("composed preparation correlation is invalid");
  }
  return receipt;
};

const completeReceipt = (
  journal: ComposedPhaseJournal,
  preparation: SpawnfileComposedPreparationReceipt,
  configuration: ComposedRunConfiguration,
): ComposedTerminalReceipt => {
  const cleanup = parseComposedCleanupReceipt(composedPhasePayload(journal, "cleaned").receipt);
  const world = parseComposedWorldEvidenceReceipt(
    composedPhasePayload(journal, "world_evidence_exported").evidence,
  );
  const organization = parseComposedOrganizationEvidenceReceipt(
    composedPhasePayload(journal, "organization_evidence_exported").evidence,
  );
  const topology = parseComposedTopologyAttestationReceipt(
    composedPhasePayload(journal, "topology_verified").attestation,
  );
  const activation = parseComposedTopologyActivationReceipt(
    composedPhasePayload(journal, "activated").activation,
  );
  const pause = parseComposedWorldPauseReceipt(
    composedPhasePayload(journal, "world_paused").receipt,
  );
  const service = parseComposedWorldServiceReceipt(
    composedPhasePayload(journal, "world_started_paused").receipt,
  );
  if (cleanup.run_id !== journal.request.run_id
    || world.run_id !== journal.request.run_id
    || world.pause_receipt_digest !== pause.receipt_digest
    || world.source_service_handle !== service.service_handle
    || organization.run_id !== journal.request.run_id
    || organization.organization_phase_digest
      !== journal.entries[composedRunPhaseIndex("organization_ready")]!.payload_digest
    || topology.run_id !== journal.request.run_id
    || activation.run_id !== journal.request.run_id
    || activation.attestation_receipt_digest !== topology.receipt_digest
    || activation.target_activation.topology_receipt_digest
      !== topology.target_topology.receipt_digest
    || activation.target_activation.topology_request_digest
      !== topology.target_topology.request_digest) {
    throw new TypeError("composed terminal topology evidence is invalid");
  }
  const sealDigest = digestComposedJson("simfile.composed-run-evidence-seal.v1", {
    organization: organization.inventory_digest,
    world: world.inventory_digest,
  });
  return createComposedTerminalReceipt({
    cleanup: {
      receipt_digest: cleanup.receipt_digest,
      remaining_owned_resources: [],
      state: "cleaned",
    },
    evidence: {
      organization: {
        authority: "organization",
        digest: organization.inventory_digest,
        item_count: organization.files.length + 1,
        state: "exported",
      },
      world: {
        authority: "world",
        digest: world.inventory_digest,
        item_count: world.item_count,
        state: "exported",
      },
    },
    journal_digest: terminalJournalDigest(journal),
    request: journal.request,
    seal: { digest: sealDigest, state: "sealed" },
    target: {
      preparation_receipt_digest: preparation.receipt_digest,
      selected_target: {
        fingerprint: preparation.selected_target.fingerprint,
        handle: preparation.selected_target.handle,
      },
      selector: journal.request.target.selector,
    },
    topology: {
      activation_receipt_digest: activation.receipt_digest,
      request_digest: topology.target_topology.request_digest,
      receipt_digest: topology.target_topology.receipt_digest,
    },
    verdict: {
      digest: digestComposedJson("simfile.composed-run-verdict.v1", {
        cleanup: cleanup.receipt_digest,
        seal: sealDigest,
        terminal_tick: configuration.terminal_tick,
      }),
      state: "valid",
    },
  });
};

/** Executes or resumes the entire composed lifecycle from one verified journal. */
export const executeComposedRun = async (input: Readonly<{
  configuration: ComposedRunConfiguration;
  context: ComposedPhaseContext;
  journal: unknown;
  ports: ComposedRunPorts;
  signal?: AbortSignal;
}>): Promise<CompletedComposedRun> => {
  let journal = parseComposedPhaseJournal(input.journal);
  const signal = input.signal ?? new AbortController().signal;
  if (journal.current_phase === "completed") {
    return completedComposedRunFromJournal(journal);
  }
  if (!composedPhaseReached(journal, "prepared")) {
    const preparation = verifyPreparation(await input.ports.preparation.prepareComposedRun({
      idempotency_key: preparationKey(journal), request: journal.request,
      signal,
    }), journal, input.configuration.topology_expectation);
    journal = await commitComposedPhase(journal, "prepared", {
      preparation,
      preparation_receipt_digest: preparation.receipt_digest,
      run_id: journal.request.run_id,
    }, input.context);
  }
  const preparation = verifyPreparation(
    composedPhasePayload(journal, "prepared").preparation,
    journal,
    input.configuration.topology_expectation,
  );
  journal = await startComposedWorld({
    context: input.context,
    journal,
    port: input.ports.world,
    preparation,
    readiness_expectation: input.configuration.readiness_expectation,
    signal,
  });
  journal = await startComposedOrganization({
    context: input.context,
    expectation: input.configuration.organization_expectation,
    journal,
    port: input.ports.organization,
    signal,
  });
  journal = await activateComposedTopology({
    context: input.context,
    expectation: input.configuration.topology_expectation,
    journal,
    port: input.ports.topology,
    signal,
  });
  journal = await superviseComposedWorld({
    context: input.context,
    expected_terminal_tick: input.configuration.terminal_tick,
    journal,
    operator_timeout_ms: input.configuration.operator_timeout_ms,
    port: input.ports.supervision,
    signal,
  });
  journal = await finalizeComposedWorld({
    context: input.context, journal, port: input.ports.world_finalization, signal,
  });
  journal = await finalizeComposedOrganization({
    context: input.context,
    deployment_name: input.configuration.deployment_name,
    journal,
    port: input.ports.organization_finalization,
    signal,
  });
  journal = await cleanupComposedRun({
    context: input.context, journal, port: input.ports.cleanup, signal,
  });
  const receipt = completeReceipt(journal, preparation, input.configuration);
  journal = await commitComposedPhase(journal, "completed", {
    receipt, receipt_digest: receipt.receipt_digest, run_id: journal.request.run_id,
  }, input.context);
  return { journal, receipt };
};
