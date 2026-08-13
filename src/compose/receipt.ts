import path from "node:path";

import { z } from "zod";

import {
  assertSecretFreeComposedJson,
  canonicalComposedJson,
  digestComposedJson,
} from "./json.js";
import { createComposedRunRequestDigest, type ComposedRunRequest } from "./request.js";
import { COMPOSED_RUN_PHASES } from "./types.js";

export const COMPOSED_TERMINAL_RECEIPT_VERSION =
  "simfile.composed-terminal-receipt.v1" as const;
export const COMPOSED_RECOVERY_RECEIPT_VERSION =
  "simfile.composed-recovery-receipt.v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const opaqueHandle = z.string().regex(/^opaque_[a-z0-9]{16,64}$/u);
const absolutePath = z.string().max(4_096).refine((value) =>
  path.isAbsolute(value) && path.normalize(value) === value && value !== path.parse(value).root);
const selectedTarget = z.object({
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{32}$/u),
  handle: opaqueHandle,
}).strict();
const evidence = z.object({
  authority: identifier,
  digest,
  item_count: z.number().int().min(0).max(1_000_000),
  state: z.literal("exported"),
}).strict();

export const composedTerminalReceiptSchema = z.object({
  cleanup: z.object({
    receipt_digest: digest,
    remaining_owned_resources: z.array(opaqueHandle).max(64),
    state: z.literal("cleaned"),
  }).strict(),
  evidence: z.object({
    organization: evidence,
    world: evidence,
  }).strict(),
  journal_digest: digest,
  receipt_digest: digest,
  request_digest: digest,
  run_id: runId,
  seal: z.object({ digest, state: z.literal("sealed") }).strict(),
  status: z.literal("completed"),
  target: z.object({
    preparation_receipt_digest: digest,
    selected_target: selectedTarget,
    selector: identifier,
  }).strict(),
  topology: z.object({
    activation_receipt_digest: digest,
    request_digest: digest,
    receipt_digest: digest,
  }).strict(),
  verdict: z.object({ digest, state: z.enum(["valid", "invalid"]) }).strict(),
  version: z.literal(COMPOSED_TERMINAL_RECEIPT_VERSION),
}).strict().superRefine((value, context) => {
  if (value.cleanup.remaining_owned_resources.length > 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "completed receipt retains resources" });
  }
});

export const composedRecoveryReceiptSchema = z.object({
  authority_digest: digest,
  journal_digest: digest,
  journal_path: absolutePath,
  next_phase: z.enum(COMPOSED_RUN_PHASES),
  preserved_evidence: z.boolean(),
  receipt_digest: digest,
  recovery_command: z.string().min(1).max(8_192),
  run_id: runId,
  signal: z.enum(["SIGINT", "SIGTERM", "restart", "failure"]),
  status: z.literal("recovery_required"),
  version: z.literal(COMPOSED_RECOVERY_RECEIPT_VERSION),
}).strict();

export type ComposedTerminalReceipt = z.infer<typeof composedTerminalReceiptSchema>;
export type ComposedRecoveryReceipt = z.infer<typeof composedRecoveryReceiptSchema>;

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

export const composedRecoveryCommand = (
  journalPath: string,
  runIdValue: string,
  authorityDigest: string,
): string => {
  const checkedPath = absolutePath.parse(journalPath);
  const checkedRun = runId.parse(runIdValue);
  const checkedAuthority = digest.parse(authorityDigest);
  return `simfile recover --journal ${shellQuote(checkedPath)} --run-id ${shellQuote(checkedRun)} --authority-digest ${shellQuote(checkedAuthority)}`;
};

const parseDigested = <Value extends { receipt_digest: string }>(
  raw: unknown,
  schema: z.ZodType<Value>,
  domain: string,
): Value => {
  assertSecretFreeComposedJson(raw);
  const value = schema.parse(raw);
  const { receipt_digest: _receiptDigest, ...body } = value;
  if (value.receipt_digest !== digestComposedJson(domain, body)) {
    throw new TypeError("composed receipt digest is invalid");
  }
  return Object.freeze(value);
};

export const parseComposedTerminalReceipt = (raw: unknown): ComposedTerminalReceipt =>
  parseDigested(raw, composedTerminalReceiptSchema, COMPOSED_TERMINAL_RECEIPT_VERSION);

export const parseComposedRecoveryReceipt = (raw: unknown): ComposedRecoveryReceipt => {
  const receipt = parseDigested(
    raw, composedRecoveryReceiptSchema, COMPOSED_RECOVERY_RECEIPT_VERSION,
  );
  if (receipt.recovery_command !== composedRecoveryCommand(
    receipt.journal_path, receipt.run_id, receipt.authority_digest,
  )) {
    throw new TypeError("composed recovery receipt command is invalid");
  }
  return receipt;
};

const sealReceipt = <Value extends Record<string, unknown>>(
  domain: string,
  body: Value,
): Value & { receipt_digest: string } => ({
  ...body,
  receipt_digest: digestComposedJson(domain, body),
});

export const createComposedTerminalReceipt = (
  body: Omit<ComposedTerminalReceipt, "receipt_digest" | "version" | "status" | "request_digest" | "run_id"> & {
    readonly request: ComposedRunRequest;
  },
): ComposedTerminalReceipt => {
  const { request, ...values } = body;
  return parseComposedTerminalReceipt(sealReceipt(COMPOSED_TERMINAL_RECEIPT_VERSION, {
    ...values,
    request_digest: createComposedRunRequestDigest(request),
    run_id: request.run_id,
    status: "completed",
    version: COMPOSED_TERMINAL_RECEIPT_VERSION,
  }));
};

export const createComposedRecoveryReceipt = (
  body: Omit<ComposedRecoveryReceipt, "receipt_digest" | "recovery_command" | "status" | "version">,
): ComposedRecoveryReceipt => parseComposedRecoveryReceipt(sealReceipt(
  COMPOSED_RECOVERY_RECEIPT_VERSION,
  {
    ...body,
    recovery_command: composedRecoveryCommand(
      body.journal_path, body.run_id, body.authority_digest,
    ),
    status: "recovery_required",
    version: COMPOSED_RECOVERY_RECEIPT_VERSION,
  },
));

export const verifyComposedTerminalReceipt = (
  raw: unknown,
  request: ComposedRunRequest,
  expectedJournalDigest?: string,
): ComposedTerminalReceipt => {
  const receipt = parseComposedTerminalReceipt(raw);
  if (receipt.run_id !== request.run_id
    || receipt.request_digest !== createComposedRunRequestDigest(request)
    || (expectedJournalDigest !== undefined && receipt.journal_digest !== expectedJournalDigest)) {
    throw new TypeError("composed terminal receipt correlation is invalid");
  }
  return receipt;
};

export const serializeComposedReceipt = (
  raw: ComposedTerminalReceipt | ComposedRecoveryReceipt,
): string => `${canonicalComposedJson(raw)}\n`;
