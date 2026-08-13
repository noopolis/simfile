import { z } from "zod";

import {
  MOLTNET_MACHINE_MAX_LINE_BYTES,
  MOLTNET_MACHINE_VERSION,
  MoltnetMachineError,
  type MoltnetMachineRequest,
  type MoltnetMachineTerminal
} from "./types.js";

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const utf8AtMost = (maximum: number) => z.string().refine((value) => Buffer.byteLength(value, "utf8") <= maximum);
const scopedMemberId = z.string().refine((value) => {
  if (value.trim() !== value || Buffer.byteLength(value, "utf8") === 0) return false;
  const fqid = /^molt:\/\/([^/]+)\/agents\/([^/]+)$/u.exec(value);
  if (fqid !== null) return identifier.safeParse(fqid[1]).success && identifier.safeParse(fqid[2]).success;
  if (value.includes(":")) {
    const components = value.split(":");
    const component = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
    return components.length === 2 && components.every((entry) => component.test(entry));
  }
  return identifier.safeParse(value).success;
});
const target = z.object({ kind: z.enum(["room", "dm"]), id: identifier }).strict();
const send = z.object({
  delivery_id: identifier, target, body: utf8AtMost(2_048).min(1).refine((value) => value.trim().length > 0),
  origin_message_id: identifier.optional(), cause_event_ids: z.array(identifier).max(32).optional()
}).strict().superRefine((value, context) => {
  if (value.cause_event_ids && new Set(value.cause_event_ids).size !== value.cause_event_ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate machine cause event" });
  }
});
const read = z.object({
  target, limit: z.number().int().min(1).max(128), before: identifier.optional(), after: identifier.optional()
}).strict().refine((value) => !(value.before && value.after), "read cursor conflict");
const cancel = z.object({ target_correlation_id: identifier }).strict();
const error = z.object({ code: z.enum([
  "invalid_request", "duplicate_request", "unsupported", "not_found", "conflict", "capacity", "transport", "canceled"
]) }).strict();
const sendResult = z.object({
  message_id: identifier, event_id: identifier, accepted: z.boolean(), thread_id: identifier.optional(),
  thread_created: z.boolean(), dm_id: identifier.optional(), dm_created: z.boolean()
}).strict().superRefine((value, context) => {
  if ((value.thread_id !== undefined) !== value.thread_created || (value.dm_id !== undefined) !== value.dm_created) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "invalid machine creation result" });
  }
});
const memberId = scopedMemberId;
const messageTarget = z.object({
  kind: z.enum(["room", "dm"]), room_id: identifier.optional(), thread_id: identifier.optional(),
  parent_message_id: identifier.optional(), dm_id: identifier.optional(), participant_ids: z.array(memberId).max(128).optional()
}).strict().superRefine((value, context) => {
  const hasRoomFields = value.room_id !== undefined || value.thread_id !== undefined || value.parent_message_id !== undefined;
  if (value.kind === "room" && (value.room_id === undefined || value.dm_id !== undefined || value.participant_ids !== undefined || value.thread_id !== undefined || value.parent_message_id !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "invalid room message target" });
  }
  if (value.kind === "dm" && (value.dm_id === undefined || hasRoomFields || value.participant_ids !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "invalid direct message target" });
  }
});
const actor = z.object({
  type: utf8AtMost(128).min(1).refine((value) => value.trim() === value), id: memberId,
  name: utf8AtMost(128).optional(), network_id: identifier.optional(), fqid: utf8AtMost(128).optional(),
  credential_bound: z.boolean().optional()
}).strict();
const knownPartKind = z.enum(["text", "url", "data", "file", "image", "audio"]);
const validPartUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "molt:")
      && (parsed.protocol === "molt:" || parsed.host.length > 0);
  } catch { return false; }
};
const part = z.object({
  kind: knownPartKind, text: utf8AtMost(4_096).optional(), media_type: utf8AtMost(128).optional(),
  url: utf8AtMost(2_048).optional(), filename: utf8AtMost(256).optional(), data: z.record(z.string(), z.unknown()).optional()
}).strict().superRefine((value, context) => {
  if (value.url !== undefined && (value.url.trim() !== value.url || !validPartUrl(value.url))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "invalid machine part URL" });
  }
  if (value.data !== undefined && Buffer.byteLength(JSON.stringify(value.data), "utf8") > 8_192) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "machine part data exceeds byte limit" });
  }
});
const readMessage = z.object({
  id: identifier, network_id: identifier, origin: z.object({ network_id: identifier, message_id: identifier }).strict(),
  target: messageTarget, from: actor, parts: z.array(part).min(1).max(64), mentions: z.array(memberId).max(128).optional(),
  created_at: z.string().datetime({ offset: true })
}).strict();
const readResult = z.object({
  target, page: z.object({
    messages: z.array(readMessage).max(128).nullable(),
    page: z.object({ has_more: z.boolean(), next_before: identifier.optional(), next_after: identifier.optional() }).strict()
      .superRefine((value, context) => {
        const cursors = Number(value.next_before !== undefined) + Number(value.next_after !== undefined);
        if ((value.has_more && cursors !== 1) || (!value.has_more && cursors !== 0)) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: "invalid machine read page" });
        }
      })
  }).strict()
}).strict();
const cancelResult = z.object({ target_correlation_id: identifier, state: z.enum(["canceled", "already_final", "not_found"]) }).strict();

const duplicateFreeJson = (line: string): unknown => {
  let index = 0;
  const whitespace = () => { while (/\s/u.test(line[index] ?? "")) index++; };
  const string = (): string => {
    const start = index++; let escaped = false;
    while (index < line.length) {
      const character = line[index++]!;
      if (escaped) { escaped = false; continue; }
      if (character === "\\") { escaped = true; continue; }
      if (character === '"') return JSON.parse(line.slice(start, index)) as string;
    }
    throw new MoltnetMachineError("malformed machine JSONL");
  };
  const value = (): void => {
    whitespace(); const current = line[index];
    if (current === '"') { string(); return; }
    if (current === "{") {
      index++; const keys = new Set<string>(); whitespace();
      while (line[index] !== "}") {
        if (line[index] !== '"') throw new MoltnetMachineError("malformed machine JSONL");
        const key = string(); if (keys.has(key)) throw new MoltnetMachineError("duplicate machine JSON key");
        keys.add(key); whitespace(); if (line[index++] !== ":") throw new MoltnetMachineError("malformed machine JSONL");
        value(); whitespace(); if (line[index] === ",") { index++; whitespace(); } else if (line[index] !== "}") throw new MoltnetMachineError("malformed machine JSONL");
      }
      index++; return;
    }
    if (current === "[") { index++; whitespace(); while (line[index] !== "]") { value(); whitespace(); if (line[index] === ",") { index++; whitespace(); } else if (line[index] !== "]") throw new MoltnetMachineError("malformed machine JSONL"); } index++; return; }
    const scalar = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(line.slice(index));
    if (!scalar) throw new MoltnetMachineError("malformed machine JSONL");
    index += scalar[0].length;
  };
  value(); whitespace();
  if (index !== line.length) throw new MoltnetMachineError("malformed machine JSONL");
  try { return JSON.parse(line) as unknown; } catch { throw new MoltnetMachineError("malformed machine JSONL"); }
};

const expectRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MoltnetMachineError("invalid machine response");
  return value as Record<string, unknown>;
};

export const encodeMoltnetMachineRequest = (request: MoltnetMachineRequest): string => {
  const allowed = request.operation === "send_nudge" ? ["version", "correlation_id", "operation", "send_nudge"]
    : request.operation === "read" ? ["version", "correlation_id", "operation", "read"]
      : request.operation === "cancel" ? ["version", "correlation_id", "operation", "cancel"] : [];
  const exact = Object.keys(request).length === allowed.length && allowed.every((key) => Object.hasOwn(request, key));
  const payload = request.operation === "send_nudge" ? send.safeParse(request.send_nudge)
    : request.operation === "read" ? read.safeParse(request.read) : cancel.safeParse(request.cancel);
  if (request.version !== MOLTNET_MACHINE_VERSION || !exact || !identifier.safeParse(request.correlation_id).success || !payload.success) {
    throw new MoltnetMachineError("invalid machine request");
  }
  const line = JSON.stringify({ version: MOLTNET_MACHINE_VERSION, correlation_id: request.correlation_id, operation: request.operation, [request.operation]: payload.data });
  if (Buffer.byteLength(line) > MOLTNET_MACHINE_MAX_LINE_BYTES) throw new MoltnetMachineError("machine request exceeds line limit");
  return line;
};

export const decodeMoltnetMachineTerminal = (line: string): MoltnetMachineTerminal => {
  if (Buffer.byteLength(line) > MOLTNET_MACHINE_MAX_LINE_BYTES) throw new MoltnetMachineError("machine response exceeds line limit");
  const raw = expectRecord(duplicateFreeJson(line));
  const keys = Object.keys(raw); const allowed = new Set(["version", "correlation_id", "operation", "send_nudge", "read", "cancel", "error"]);
  if (keys.some((key) => !allowed.has(key))) throw new MoltnetMachineError("unknown machine response field");
  if (raw.version !== MOLTNET_MACHINE_VERSION || !identifier.safeParse(raw.correlation_id).success) throw new MoltnetMachineError("machine response version or correlation mismatch");
  if (raw.operation !== "send_nudge" && raw.operation !== "read" && raw.operation !== "cancel") throw new MoltnetMachineError("non-terminal machine response");
  const operation = raw.operation; const payloadKey = operation;
  const payloads = [raw.send_nudge, raw.read, raw.cancel, raw.error].filter((value) => value !== undefined);
  if (payloads.length !== 1 || (raw[payloadKey] === undefined && raw.error === undefined)) throw new MoltnetMachineError("invalid machine terminal response");
  if (raw.error !== undefined && !error.safeParse(raw.error).success) throw new MoltnetMachineError("invalid machine error response");
  const result = operation === "send_nudge" ? sendResult : operation === "read" ? readResult : cancelResult;
  if (raw[payloadKey] !== undefined && !result.safeParse(raw[payloadKey]).success) throw new MoltnetMachineError("invalid machine result response");
  return raw as MoltnetMachineTerminal;
};
