import { z } from "zod";
import { targetResourceReceiptSchema } from "../spawnfile/targetReceipts.js";

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
import { parseComposedWorldServiceReceipt } from "./startup-world.js";
import { parseComposedWorldTerminalReceipt } from "./supervision.js";

export const COMPOSED_WORLD_PAUSE_VERSION = "simfile.composed-world-pause.v1" as const;
export const COMPOSED_WORLD_EVIDENCE_VERSION = "simfile.composed-world-evidence.v1" as const;
export const WORLD_EVIDENCE_RECOVERY_INSTRUCTION =
  "resume the persisted composed journal at world_evidence_exported" as const;

const evidencePath = z.string().max(512).regex(
  /^(?:\.spawnfile\/)?(?:[a-z0-9][a-z0-9._-]*\/)*[a-z0-9][a-z0-9._-]*$/u,
);
const inventoryEntry = z.object({
  authority: z.enum(["actions", "checkpoints", "projections"]),
  bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  path: evidencePath,
  sha256: composedDigestSchema,
}).strict();
const pauseSchema = z.object({
  final_tick: z.number().int().min(1).max(1_000_000_000),
  receipt_digest: composedDigestSchema,
  run_id: composedRunIdSchema,
  service_handle: composedHandleSchema,
  state: z.literal("paused"),
  target_operation: targetResourceReceiptSchema.optional(),
  terminal_receipt_digest: composedDigestSchema,
  version: z.literal(COMPOSED_WORLD_PAUSE_VERSION),
}).strict();
const evidenceSchema = z.object({
  export_handle: composedHandleSchema,
  flushed_authorities: z.tuple([
    z.literal("actions"), z.literal("checkpoints"), z.literal("projections"),
  ]),
  inventory: z.array(inventoryEntry).min(3).max(100_000),
  inventory_digest: composedDigestSchema,
  item_count: z.number().int().min(3).max(100_000),
  pause_receipt_digest: composedDigestSchema,
  receipt_digest: composedDigestSchema,
  run_id: composedRunIdSchema,
  source_service_handle: composedHandleSchema,
  source_state: z.literal("preserved"),
  state: z.literal("exported"),
  target_operation: targetResourceReceiptSchema.optional(),
  version: z.literal(COMPOSED_WORLD_EVIDENCE_VERSION),
}).strict().superRefine((value, context) => {
  const paths = value.inventory.map((item) => item.path);
  const authorities = new Set(value.inventory.map((item) => item.authority));
  if (value.item_count !== value.inventory.length
    || new Set(paths).size !== paths.length
    || paths.some((item, index) => index > 0 && paths[index - 1]! >= item)
    || (["actions", "checkpoints", "projections"] as const)
      .some((item) => !authorities.has(item))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "world evidence inventory is invalid" });
  }
});

export type ComposedWorldPauseReceipt = z.infer<typeof pauseSchema>;
export type ComposedWorldEvidenceReceipt = z.infer<typeof evidenceSchema>;
export type ComposedWorldEvidenceItem = z.infer<typeof inventoryEntry>;

export class ComposedWorldEvidenceError extends Error {
  readonly recovery_instruction: string;
  readonly source_preserved = true;

  constructor(nextPhase: "world_evidence_exported" | "world_paused") {
    super("composed world evidence is recoverable");
    this.name = "ComposedWorldEvidenceError";
    this.recovery_instruction = nextPhase === "world_evidence_exported"
      ? WORLD_EVIDENCE_RECOVERY_INSTRUCTION
      : "resume the persisted composed journal at world_paused";
  }
}

export const parseComposedWorldPauseReceipt = (raw: unknown): ComposedWorldPauseReceipt =>
  parseComposedDigestedContract(raw, pauseSchema,
    COMPOSED_WORLD_PAUSE_VERSION, "composed world pause receipt");
export const createComposedWorldPauseReceipt = (
  fields: Omit<ComposedWorldPauseReceipt, "receipt_digest" | "state" | "version">,
): ComposedWorldPauseReceipt => parseComposedWorldPauseReceipt(sealComposedContract(
  COMPOSED_WORLD_PAUSE_VERSION,
  { ...fields, state: "paused", version: COMPOSED_WORLD_PAUSE_VERSION },
));

export const parseComposedWorldEvidenceReceipt = (raw: unknown): ComposedWorldEvidenceReceipt => {
  const receipt = parseComposedDigestedContract(raw, evidenceSchema,
    COMPOSED_WORLD_EVIDENCE_VERSION, "composed world evidence receipt");
  if (receipt.inventory_digest !== digestComposedJson(
    "simfile.composed-world-evidence-inventory.v1", receipt.inventory,
  )) throw new TypeError("composed world evidence inventory digest is invalid");
  return receipt;
};
export const createComposedWorldEvidenceReceipt = (fields: Readonly<{
  export_handle: string;
  inventory: readonly ComposedWorldEvidenceItem[];
  pause_receipt_digest: string;
  run_id: string;
  source_service_handle: string;
  target_operation?: z.infer<typeof targetResourceReceiptSchema>;
}>): ComposedWorldEvidenceReceipt => {
  const inventory = [...fields.inventory].sort((left, right) => left.path.localeCompare(right.path));
  return parseComposedWorldEvidenceReceipt(sealComposedContract(COMPOSED_WORLD_EVIDENCE_VERSION, {
    ...fields,
    flushed_authorities: ["actions", "checkpoints", "projections"],
    inventory,
    inventory_digest: digestComposedJson("simfile.composed-world-evidence-inventory.v1", inventory),
    item_count: inventory.length,
    source_state: "preserved",
    state: "exported",
    version: COMPOSED_WORLD_EVIDENCE_VERSION,
  }));
};

export interface ComposedWorldFinalizationPort {
  exportWorldEvidence(input: Readonly<{
    idempotency_key: string;
    pause: ComposedWorldPauseReceipt;
    signal: AbortSignal;
  }>): Promise<unknown>;
  pauseWorld(input: Readonly<{
    idempotency_key: string;
    service: ReturnType<typeof parseComposedWorldServiceReceipt>;
    signal: AbortSignal;
    terminal: ReturnType<typeof parseComposedWorldTerminalReceipt>;
  }>): Promise<unknown>;
}

const operationKey = (journal: ComposedPhaseJournal, operation: string): string =>
  `idem_${digestComposedJson("simfile.composed-world-finalization-operation.v1", {
    operation, request_digest: journal.request_digest,
  }).slice(7, 39)}`;

/** Pauses and exports exact world evidence; no destructive operation exists here. */
export const finalizeComposedWorld = async (input: Readonly<{
  context: ComposedPhaseContext;
  journal: unknown;
  port: ComposedWorldFinalizationPort;
  signal?: AbortSignal;
}>): Promise<ComposedPhaseJournal> => {
  let journal = parseComposedPhaseJournal(input.journal);
  if (!composedPhaseReached(journal, "terminal")) {
    throw new TypeError("composed world finalization requires terminal state");
  }
  const service = parseComposedWorldServiceReceipt(
    composedPhasePayload(journal, "world_started_paused").receipt,
  );
  const terminal = parseComposedWorldTerminalReceipt(
    composedPhasePayload(journal, "terminal").receipt,
  );
  if (!composedPhaseReached(journal, "world_paused")) {
    let pause: ComposedWorldPauseReceipt;
    try {
      pause = parseComposedWorldPauseReceipt(await input.port.pauseWorld({
        idempotency_key: operationKey(journal, "pause_world"), service, terminal,
        signal: input.signal ?? new AbortController().signal,
      }));
    } catch {
      throw new ComposedWorldEvidenceError("world_paused");
    }
    if (pause.run_id !== journal.request.run_id
      || pause.service_handle !== service.service_handle
      || pause.terminal_receipt_digest !== terminal.receipt_digest
      || pause.final_tick !== terminal.terminal_tick) {
      throw new ComposedWorldEvidenceError("world_paused");
    }
    journal = await commitComposedPhase(journal, "world_paused", {
      receipt: pause, receipt_digest: pause.receipt_digest, run_id: journal.request.run_id,
    }, input.context);
  }
  const pause = parseComposedWorldPauseReceipt(
    composedPhasePayload(journal, "world_paused").receipt,
  );
  if (!composedPhaseReached(journal, "world_evidence_exported")) {
    let evidence: ComposedWorldEvidenceReceipt;
    try {
      evidence = parseComposedWorldEvidenceReceipt(await input.port.exportWorldEvidence({
        idempotency_key: operationKey(journal, "export_world_evidence"), pause,
        signal: input.signal ?? new AbortController().signal,
      }));
    } catch {
      throw new ComposedWorldEvidenceError("world_evidence_exported");
    }
    if (evidence.run_id !== journal.request.run_id
      || evidence.pause_receipt_digest !== pause.receipt_digest
      || evidence.source_service_handle !== service.service_handle) {
      throw new ComposedWorldEvidenceError("world_evidence_exported");
    }
    journal = await commitComposedPhase(journal, "world_evidence_exported", {
      evidence, receipt_digest: evidence.receipt_digest, run_id: journal.request.run_id,
    }, input.context);
  }
  return journal;
};
