import { createHash } from "node:crypto";

import { z } from "zod";

import { parseSpawnfileComposedPreparationReceipt } from "../spawnfile/preparationReceipt.js";
import {
  composedDigestSchema,
  composedHandleSchema,
  composedIdentifierSchema,
  composedRunIdSchema,
  parseComposedDigestedContract,
  sealComposedContract,
} from "./contracts.js";
import { parseComposedOrganizationEvidenceReceipt } from "./finalize-organization.js";
import {
  parseComposedWorldEvidenceReceipt,
  parseComposedWorldPauseReceipt,
} from "./finalize-world.js";
import { canonicalComposedJson, digestComposedJson } from "./json.js";
import { parseComposedPhaseJournal, type ComposedPhaseJournal } from "./journal.js";
import {
  commitComposedPhase,
  composedPhasePayload,
  composedPhaseReached,
  type ComposedPhaseContext,
} from "./phase.js";
import {
  parseComposedWorldResourceReceipt,
  parseComposedWorldServiceReceipt,
} from "./startup-world.js";
import { parseComposedWorldTerminalReceipt } from "./supervision.js";
import { composedRunPhaseIndex } from "./types.js";

export const COMPOSED_CLEANUP_OPERATION_VERSION = "simfile.composed-cleanup-operation.v1" as const;
export const COMPOSED_CLEANUP_VERSION = "simfile.composed-cleanup.v1" as const;

const operation = z.enum([
  "stop_world", "detach_organization", "down_organization",
  "revoke_secret_bindings", "cleanup_target_resources",
]);
const handles = z.array(composedHandleSchema).max(16);
const operationSchema = z.object({
  operation,
  ownership_digest: composedDigestSchema,
  receipt_digest: composedDigestSchema,
  released_handles: handles,
  remaining_owned_handles: handles,
  run_id: composedRunIdSchema,
  state: z.enum(["completed", "incomplete"]),
  target_handles: handles,
  version: z.literal(COMPOSED_CLEANUP_OPERATION_VERSION),
}).strict();
const cleanupSchema = z.object({
  operations: z.tuple([
    operationSchema, operationSchema, operationSchema, operationSchema, operationSchema,
  ]),
  ownership_digest: composedDigestSchema,
  receipt_digest: composedDigestSchema,
  remaining_owned_resources: z.tuple([]),
  run_id: composedRunIdSchema,
  state: z.literal("cleaned"),
  version: z.literal(COMPOSED_CLEANUP_VERSION),
}).strict();
const organizationOwner = z.object({
  deployment: z.object({ name: composedIdentifierSchema }).passthrough(),
  organization_handoff: z.object({
    network_attachment_handle: composedHandleSchema,
    selected_target_receipt_digest: composedDigestSchema,
  }).passthrough(),
  organization_handoff_handle: composedHandleSchema,
  run_id: composedRunIdSchema,
  target_attachment: z.object({
    operation: z.literal("attach_organization"),
    result_handle: composedHandleSchema,
  }).passthrough(),
}).passthrough();

export type ComposedCleanupOperation = z.infer<typeof operation>;
export type ComposedCleanupOperationReceipt = z.infer<typeof operationSchema>;
export type ComposedCleanupReceipt = z.infer<typeof cleanupSchema>;

export class ComposedCleanupError extends Error {
  readonly failed_operation: ComposedCleanupOperation;
  readonly remaining_owned_resources: readonly string[];

  constructor(operationName: ComposedCleanupOperation, remaining: readonly string[]) {
    super("composed cleanup is incomplete");
    this.name = "ComposedCleanupError";
    this.failed_operation = operationName;
    this.remaining_owned_resources = Object.freeze([...remaining].sort());
  }
}

const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort();
const exactHandles = (left: readonly string[], right: readonly string[]): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export const parseComposedCleanupOperationReceipt = (
  raw: unknown,
): ComposedCleanupOperationReceipt => {
  const receipt = parseComposedDigestedContract(raw, operationSchema,
    COMPOSED_CLEANUP_OPERATION_VERSION, "composed cleanup operation receipt");
  const target = sortedUnique(receipt.target_handles);
  const released = sortedUnique(receipt.released_handles);
  const remaining = sortedUnique(receipt.remaining_owned_handles);
  if (!exactHandles(target, receipt.target_handles)
    || !exactHandles(released, receipt.released_handles)
    || !exactHandles(remaining, receipt.remaining_owned_handles)
    || released.some((handle) => !target.includes(handle))) {
    throw new TypeError("composed cleanup operation handles are invalid");
  }
  return receipt;
};
export const createComposedCleanupOperationReceipt = (
  body: Omit<ComposedCleanupOperationReceipt, "receipt_digest" | "version">,
): ComposedCleanupOperationReceipt => parseComposedCleanupOperationReceipt(sealComposedContract(
  COMPOSED_CLEANUP_OPERATION_VERSION,
  { ...body, version: COMPOSED_CLEANUP_OPERATION_VERSION },
));
export const parseComposedCleanupReceipt = (raw: unknown): ComposedCleanupReceipt => {
  const receipt = parseComposedDigestedContract(raw, cleanupSchema,
    COMPOSED_CLEANUP_VERSION, "composed cleanup receipt");
  const expected = operation.options;
  if (receipt.operations.some((rawItem, index) => {
    const item = parseComposedCleanupOperationReceipt(rawItem);
    return item.operation !== expected[index]
      || item.run_id !== receipt.run_id || item.ownership_digest !== receipt.ownership_digest
      || item.state !== "completed";
  })) throw new TypeError("composed cleanup sequence is invalid");
  return receipt;
};

interface CleanupOwnership {
  readonly data_network: string;
  readonly evidence_volume: string;
  readonly organization_attachment: string;
  readonly organization_handoff: string;
  readonly secret_bindings: string;
  readonly world_resource: string;
  readonly world_service: string;
}

const deriveOwnership = (journal: ComposedPhaseJournal): Readonly<CleanupOwnership> => {
  const prepared = parseSpawnfileComposedPreparationReceipt(
    composedPhasePayload(journal, "prepared").preparation,
  );
  const world = parseComposedWorldResourceReceipt(
    composedPhasePayload(journal, "world_created").receipt,
  );
  const service = parseComposedWorldServiceReceipt(
    composedPhasePayload(journal, "world_started_paused").receipt,
  );
  const organization = organizationOwner.parse(
    composedPhasePayload(journal, "organization_started").up_receipt,
  );
  const selectedDigest = `sha256:${createHash("sha256")
    .update(canonicalComposedJson(prepared.selected_target), "utf8").digest("hex")}`;
  if (prepared.run_id !== journal.request.run_id
    || prepared.receipt_digest !== composedPhasePayload(journal, "prepared").preparation_receipt_digest
    || prepared.descriptor_digest !== journal.request.descriptor_digest
    || prepared.organization.artifact_digest !== journal.request.organization.artifact_digest
    || prepared.organization.world_bindings_digest !== journal.request.organization.world_bindings_digest
    || prepared.world.artifact_manifest_digest !== journal.request.world.artifact_manifest_digest
    || prepared.world.bundle_digest !== journal.request.world.bundle_digest
    || prepared.target_selector !== journal.request.target.selector
    || organization.run_id !== journal.request.run_id
    || organization.organization_handoff.selected_target_receipt_digest !== selectedDigest) {
    throw new TypeError("composed cleanup ownership correlation is invalid");
  }
  const ownership = Object.freeze({
    data_network: prepared.resources.data_network.result_handle,
    evidence_volume: prepared.resources.evidence_volume.result_handle,
    organization_attachment: organization.target_attachment.result_handle,
    organization_handoff: organization.organization_handoff_handle,
    secret_bindings: prepared.resources.secret_bindings.result_handle,
    world_resource: world.resource_handle,
    world_service: service.service_handle,
  });
  if (new Set(Object.values(ownership)).size !== Object.keys(ownership).length) {
    throw new TypeError("composed cleanup ownership handles are not unique");
  }
  return ownership;
};

const verifyEvidenceCorrelation = (journal: ComposedPhaseJournal): void => {
  const worldPayload = composedPhasePayload(journal, "world_evidence_exported");
  const organizationPayload = composedPhasePayload(journal, "organization_evidence_exported");
  const world = parseComposedWorldEvidenceReceipt(worldPayload.evidence);
  const organization = parseComposedOrganizationEvidenceReceipt(organizationPayload.evidence);
  const pause = parseComposedWorldPauseReceipt(
    composedPhasePayload(journal, "world_paused").receipt,
  );
  const terminal = parseComposedWorldTerminalReceipt(
    composedPhasePayload(journal, "terminal").receipt,
  );
  const service = parseComposedWorldServiceReceipt(
    composedPhasePayload(journal, "world_started_paused").receipt,
  );
  const owner = organizationOwner.parse(
    composedPhasePayload(journal, "organization_started").up_receipt,
  );
  if (world.run_id !== journal.request.run_id
    || worldPayload.receipt_digest !== world.receipt_digest
    || world.pause_receipt_digest !== pause.receipt_digest
    || world.source_service_handle !== service.service_handle
    || pause.run_id !== journal.request.run_id
    || pause.service_handle !== service.service_handle
    || pause.terminal_receipt_digest !== terminal.receipt_digest
    || pause.final_tick !== terminal.terminal_tick
    || terminal.run_id !== journal.request.run_id
    || service.run_id !== journal.request.run_id
    || organization.run_id !== journal.request.run_id
    || organizationPayload.receipt_digest !== organization.receipt_digest
    || organization.deployment !== owner.deployment.name
    || organization.organization_phase_digest
      !== journal.entries[composedRunPhaseIndex("organization_ready")]!.payload_digest) {
    throw new TypeError("composed evidence correlation is invalid");
  }
};

export interface ComposedCleanupPort {
  performCleanupOperation(input: Readonly<{
    idempotency_key: string;
    operation: ComposedCleanupOperation;
    owned_handles: readonly string[];
    ownership_digest: string;
    run_id: string;
    signal: AbortSignal;
    target_handles: readonly string[];
  }>): Promise<unknown>;
}

const targetsFor = (ownership: CleanupOwnership): Readonly<Record<ComposedCleanupOperation, string[]>> => ({
  cleanup_target_resources: sortedUnique([
    ownership.data_network, ownership.evidence_volume,
    ownership.world_resource, ownership.world_service,
  ]),
  detach_organization: [ownership.organization_attachment],
  down_organization: [ownership.organization_handoff],
  revoke_secret_bindings: [ownership.secret_bindings],
  stop_world: [ownership.world_service],
});
const operationKey = (journal: ComposedPhaseJournal, name: string): string =>
  `idem_${digestComposedJson("simfile.composed-cleanup-operation-key.v1", {
    operation: name, request_digest: journal.request_digest,
  }).slice(7, 39)}`;

/** Cleans only handles derived from verified lifecycle receipts after both exports. */
export const cleanupComposedRun = async (input: Readonly<{
  context: ComposedPhaseContext;
  journal: unknown;
  port: ComposedCleanupPort;
  signal?: AbortSignal;
}>): Promise<ComposedPhaseJournal> => {
  let journal = parseComposedPhaseJournal(input.journal);
  if (!composedPhaseReached(journal, "organization_evidence_exported")) {
    throw new TypeError("composed cleanup requires both evidence exports");
  }
  verifyEvidenceCorrelation(journal);
  if (composedPhaseReached(journal, "cleaned")) {
    parseComposedCleanupReceipt(composedPhasePayload(journal, "cleaned").receipt);
    return journal;
  }
  const ownership = deriveOwnership(journal);
  const ownershipDigest = digestComposedJson("simfile.composed-cleanup-ownership.v1", ownership);
  const targets = targetsFor(ownership);
  let remaining = sortedUnique(Object.values(ownership));
  const receipts: ComposedCleanupOperationReceipt[] = [];
  for (const name of operation.options) {
    const targetHandles = targets[name];
    let receipt: ComposedCleanupOperationReceipt;
    try {
      receipt = parseComposedCleanupOperationReceipt(await input.port.performCleanupOperation({
        idempotency_key: operationKey(journal, name),
        operation: name,
        owned_handles: remaining,
        ownership_digest: ownershipDigest,
        run_id: journal.request.run_id,
        signal: input.signal ?? new AbortController().signal,
        target_handles: targetHandles,
      }));
    } catch {
      throw new ComposedCleanupError(name, remaining);
    }
    const releasable = name === "stop_world" ? [] : targetHandles;
    const expectedRemaining = remaining.filter((handle) => !receipt.released_handles.includes(handle));
    if (receipt.run_id !== journal.request.run_id
      || receipt.operation !== name
      || receipt.ownership_digest !== ownershipDigest
      || !exactHandles(receipt.target_handles, targetHandles)
      || receipt.released_handles.some((handle) => !releasable.includes(handle))
      || !exactHandles(receipt.remaining_owned_handles, expectedRemaining)) {
      throw new ComposedCleanupError(name, remaining);
    }
    remaining = expectedRemaining;
    receipts.push(receipt);
    if (receipt.state !== "completed") throw new ComposedCleanupError(name, remaining);
    if (!exactHandles(receipt.released_handles, releasable)) {
      throw new ComposedCleanupError(name, remaining);
    }
  }
  if (remaining.length > 0) throw new ComposedCleanupError("cleanup_target_resources", remaining);
  const receipt = parseComposedCleanupReceipt(sealComposedContract(COMPOSED_CLEANUP_VERSION, {
    operations: receipts,
    ownership_digest: ownershipDigest,
    remaining_owned_resources: [],
    run_id: journal.request.run_id,
    state: "cleaned",
    version: COMPOSED_CLEANUP_VERSION,
  }));
  journal = await commitComposedPhase(journal, "cleaned", {
    receipt, receipt_digest: receipt.receipt_digest, run_id: journal.request.run_id,
  }, input.context);
  return journal;
};
