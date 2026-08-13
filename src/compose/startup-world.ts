import { z } from "zod";
import { targetResourceReceiptSchema } from "../spawnfile/targetReceipts.js";

import {
  verifyWorldSidecarReadiness,
  type WorldSidecarReadiness,
  type WorldSidecarReadinessExpectation,
} from "../world-artifact/readiness.js";
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

export const COMPOSED_WORLD_RESOURCE_VERSION = "simfile.composed-world-resource.v1" as const;
export const COMPOSED_WORLD_SERVICE_VERSION = "simfile.composed-world-service.v1" as const;

const worldResourceSchema = z.object({
  artifact_digest: composedDigestSchema,
  bundle_digest: composedDigestSchema,
  preparation_receipt_digest: composedDigestSchema,
  receipt_digest: composedDigestSchema,
  resource_handle: composedHandleSchema,
  run_id: composedRunIdSchema,
  target_operation: targetResourceReceiptSchema.optional(),
  version: z.literal(COMPOSED_WORLD_RESOURCE_VERSION),
}).strict();
const worldServiceSchema = z.object({
  receipt_digest: composedDigestSchema,
  resource_handle: composedHandleSchema,
  run_id: composedRunIdSchema,
  service_handle: composedHandleSchema,
  state: z.literal("paused"),
  target_operation: targetResourceReceiptSchema.optional(),
  version: z.literal(COMPOSED_WORLD_SERVICE_VERSION),
}).strict();

export type ComposedWorldResourceReceipt = z.infer<typeof worldResourceSchema>;
export type ComposedWorldServiceReceipt = z.infer<typeof worldServiceSchema>;

export const createComposedWorldResourceReceipt = (
  fields: Omit<ComposedWorldResourceReceipt, "receipt_digest" | "version">,
): ComposedWorldResourceReceipt => parseComposedWorldResourceReceipt(sealComposedContract(
  COMPOSED_WORLD_RESOURCE_VERSION,
  { ...fields, version: COMPOSED_WORLD_RESOURCE_VERSION },
));
export const parseComposedWorldResourceReceipt = (raw: unknown): ComposedWorldResourceReceipt =>
  parseComposedDigestedContract(raw, worldResourceSchema,
    COMPOSED_WORLD_RESOURCE_VERSION, "composed world resource receipt");
export const createComposedWorldServiceReceipt = (
  fields: Omit<ComposedWorldServiceReceipt, "receipt_digest" | "version" | "state">,
): ComposedWorldServiceReceipt => parseComposedWorldServiceReceipt(sealComposedContract(
  COMPOSED_WORLD_SERVICE_VERSION,
  { ...fields, state: "paused", version: COMPOSED_WORLD_SERVICE_VERSION },
));
export const parseComposedWorldServiceReceipt = (raw: unknown): ComposedWorldServiceReceipt =>
  parseComposedDigestedContract(raw, worldServiceSchema,
    COMPOSED_WORLD_SERVICE_VERSION, "composed world service receipt");

export interface WorldStartupPreparation {
  readonly receipt_digest: string;
  readonly run_id: string;
  readonly world: Readonly<{
    readonly artifact_manifest_digest: string;
    readonly bundle_digest: string;
  }>;
}

export interface ComposedWorldStartupPort {
  createWorldResource(input: Readonly<{
    idempotency_key: string;
    preparation: WorldStartupPreparation;
    signal: AbortSignal;
  }>): Promise<unknown>;
  startWorldPaused(input: Readonly<{
    idempotency_key: string;
    resource: ComposedWorldResourceReceipt;
    signal: AbortSignal;
  }>): Promise<unknown>;
  readWorldReadiness(input: Readonly<{
    service: ComposedWorldServiceReceipt;
    signal: AbortSignal;
  }>): Promise<unknown>;
}

const operationKey = (journal: ComposedPhaseJournal, operation: string): string =>
  `idem_${digestComposedJson("simfile.composed-world-operation.v1", {
    operation, request_digest: journal.request_digest,
  }).slice("sha256:".length, "sha256:".length + 32)}`;

const resourceFromJournal = (journal: ComposedPhaseJournal): ComposedWorldResourceReceipt =>
  parseComposedWorldResourceReceipt(composedPhasePayload(journal, "world_created").receipt);
const serviceFromJournal = (journal: ComposedPhaseJournal): ComposedWorldServiceReceipt =>
  parseComposedWorldServiceReceipt(composedPhasePayload(journal, "world_started_paused").receipt);

/** Advances only the world through paused, pristine, organization-absent readiness. */
export const startComposedWorld = async (input: Readonly<{
  context: ComposedPhaseContext;
  journal: unknown;
  port: ComposedWorldStartupPort;
  preparation: WorldStartupPreparation;
  readiness_expectation: WorldSidecarReadinessExpectation;
  signal?: AbortSignal;
}>): Promise<ComposedPhaseJournal> => {
  let journal = parseComposedPhaseJournal(input.journal);
  if (!composedPhaseReached(journal, "prepared")) {
    throw new TypeError("composed world startup requires prepared resources");
  }
  if (input.preparation.run_id !== journal.request.run_id
    || input.preparation.receipt_digest
      !== composedPhasePayload(journal, "prepared").preparation_receipt_digest
    || input.preparation.world.artifact_manifest_digest
      !== journal.request.world.artifact_manifest_digest
    || input.preparation.world.bundle_digest !== journal.request.world.bundle_digest) {
    throw new TypeError("composed world preparation correlation is invalid");
  }
  if (!composedPhaseReached(journal, "world_created")) {
    const receipt = parseComposedWorldResourceReceipt(await input.port.createWorldResource({
      idempotency_key: operationKey(journal, "create_world_resource"),
      preparation: input.preparation,
      signal: input.signal ?? new AbortController().signal,
    }));
    if (receipt.run_id !== journal.request.run_id
      || receipt.preparation_receipt_digest !== input.preparation.receipt_digest
      || receipt.artifact_digest !== journal.request.world.artifact_manifest_digest
      || receipt.bundle_digest !== journal.request.world.bundle_digest) {
      throw new TypeError("composed world resource correlation is invalid");
    }
    journal = await commitComposedPhase(journal, "world_created", {
      receipt, run_id: journal.request.run_id,
    }, input.context);
  }
  const resource = resourceFromJournal(journal);
  if (!composedPhaseReached(journal, "world_started_paused")) {
    const receipt = parseComposedWorldServiceReceipt(await input.port.startWorldPaused({
      idempotency_key: operationKey(journal, "start_world_paused"), resource,
      signal: input.signal ?? new AbortController().signal,
    }));
    if (receipt.run_id !== journal.request.run_id
      || receipt.resource_handle !== resource.resource_handle) {
      throw new TypeError("composed world service correlation is invalid");
    }
    journal = await commitComposedPhase(journal, "world_started_paused", {
      receipt, run_id: journal.request.run_id,
    }, input.context);
  }
  if (!composedPhaseReached(journal, "world_ready")) {
    const readiness: WorldSidecarReadiness = verifyWorldSidecarReadiness(
      await input.port.readWorldReadiness({
        service: serviceFromJournal(journal),
        signal: input.signal ?? new AbortController().signal,
      }),
      input.readiness_expectation,
    );
    if (readiness.run_id !== journal.request.run_id) {
      throw new TypeError("composed world readiness run is invalid");
    }
    journal = await commitComposedPhase(journal, "world_ready", {
      readiness,
      readiness_digest: digestComposedJson("simfile.composed-world-readiness.v1", readiness),
      run_id: journal.request.run_id,
    }, input.context);
  }
  return journal;
};
