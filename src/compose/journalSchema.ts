import { z } from "zod";

import {
  composedBootstrapBindingSchema,
  composedBootstrapCapsuleSchema,
} from "./bootstrapAuthority.js";
import { composedBootstrapOperationSchema } from "./bootstrapOperationContract.js";
import { composedExecutionSchema } from "./execution.js";
import { composedRunRequestSchema } from "./request.js";
import { COMPOSED_RUN_PHASES } from "./types.js";

export const COMPOSED_PHASE_JOURNAL_VERSION =
  "simfile.composed-phase-journal.v1" as const;
export const COMPOSED_PHASE_JOURNAL_BOOTSTRAP_VERSION =
  "simfile.composed-phase-journal.v2" as const;
export const COMPOSED_JOURNAL_AUTHORITY_VERSION =
  "simfile.composed-journal-authority.v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const journalTimestampSchema = z.string().datetime({ offset: true });
const payload = z.record(z.string(), z.unknown());
const entry = z.object({
  payload,
  payload_digest: digest,
  phase: z.enum(COMPOSED_RUN_PHASES),
  recorded_at: journalTimestampSchema,
  sequence: z.number().int().min(0).max(COMPOSED_RUN_PHASES.length - 1),
}).strict();
const operation = z.object({
  command: z.string().regex(/^[a-z][a-z_]{1,63}$/u),
  operation_id: digest,
  recorded_at: journalTimestampSchema,
  request: payload,
  request_digest: digest,
  sequence: z.number().int().min(0).max(1_023),
  state: z.enum(["intent_durable", "completed", "lookup_required", "not_applied", "pending"]),
  target_receipt: payload.optional(),
}).strict();

export const composedPhaseJournalSchema = z.object({
  authority_digest: digest,
  bootstrap: composedBootstrapCapsuleSchema.optional(),
  bootstrap_binding: composedBootstrapBindingSchema.optional(),
  bootstrap_operations: z.array(composedBootstrapOperationSchema).max(16).optional(),
  current_phase: z.enum(COMPOSED_RUN_PHASES),
  entries: z.array(entry).min(1).max(COMPOSED_RUN_PHASES.length),
  execution: composedExecutionSchema.optional(),
  genesis_nonce: z.string().regex(/^[a-f0-9]{64}$/u),
  interruption: z.object({
    next_phase: z.enum(COMPOSED_RUN_PHASES),
    recovery_command: z.string().min(1).max(8_192),
    signal: z.enum(["SIGINT", "SIGTERM", "restart", "failure"]),
  }).strict().nullable(),
  journal_digest: digest,
  operations: z.array(operation).max(1_024).optional(),
  request: composedRunRequestSchema,
  request_digest: digest,
  state: z.enum(["active", "recoverable", "complete"]),
  version: z.enum([
    COMPOSED_PHASE_JOURNAL_VERSION,
    COMPOSED_PHASE_JOURNAL_BOOTSTRAP_VERSION,
  ]),
}).strict();

export type ComposedPhaseJournal = z.infer<typeof composedPhaseJournalSchema>;
