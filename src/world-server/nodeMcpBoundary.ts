import type { IncomingMessage, ServerResponse } from "node:http";

import { WORLD_HANDLER_LIMITS } from "./handler.js";
import { parseWorldJson, WorldJsonCodecError } from "./jsonCodec.js";

export type McpParsedHeaders = ReadonlyMap<string, string>;
export type McpBoundaryResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}>;
export type McpBodyResult = Readonly<{ kind: "body"; value: unknown }>
  | Readonly<{ kind: "cancelled" | "invalid" | "large" | "timeout" }>;
export type McpReadResult = Readonly<{ kind: "bytes"; bytes: Uint8Array }>
  | Readonly<{ kind: "cancelled" | "invalid" | "large" | "timeout" }>;
export type McpAsyncResult<T> = Readonly<{ kind: "value"; value: T }>
  | Readonly<{ kind: "cancelled" | "error" | "timeout" }>;

const UTF8 = new TextEncoder();
const JSON_HEADERS = Object.freeze({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });

export const mcpBoundaryError = (status: number, code: string): McpBoundaryResponse => Object.freeze({
  status,
  headers: JSON_HEADERS,
  body: UTF8.encode(JSON.stringify({ error: { code } })),
});

export const validMcpSessionId = (value: unknown): value is string => typeof value === "string"
  && /^[A-Za-z0-9._~-]{1,128}$/u.test(value);

export const parseMcpAuthorization = (value: string | undefined): string | undefined => {
  if (value === undefined || value.length > WORLD_HANDLER_LIMITS.bearer_code_units + 7) return undefined;
  return /^Bearer ([A-Za-z0-9._~+\/-]+={0,2})$/u.exec(value)?.[1];
};

export const parseMcpContentLength = (value: string | undefined, maximum: number): number | undefined | false => {
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : false;
};

export const drainMcpRequest = (request: IncomingMessage): void => {
  try { request.resume(); } catch { /* Boundary cleanup only. */ }
};
export const swallowMcpTerminalError = (): void => {};

export const parseMcpHeaders = (request: IncomingMessage, maximum: number): McpParsedHeaders | undefined => {
  try {
    if (request.rawHeaders.length % 2 !== 0) return undefined;
    const output = new Map<string, string>();
    let size = 0;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const rawName = request.rawHeaders[index]; const value = request.rawHeaders[index + 1];
      if (rawName === undefined || value === undefined) return undefined;
      const name = rawName.toLowerCase();
      if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(name) || /[\u0000-\u001f\u007f]/u.test(value) || output.has(name)) return undefined;
      size += UTF8.encode(name).byteLength + UTF8.encode(value).byteLength + 4;
      if (size > maximum) return undefined;
      output.set(name, value);
    }
    return output;
  } catch { return undefined; }
};

export const interruptMcp = async <T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timedOut: () => boolean,
): Promise<McpAsyncResult<T>> => {
  if (signal.aborted) return { kind: timedOut() ? "timeout" : "cancelled" };
  let abort: (() => void) | undefined;
  const stopped = new Promise<"cancelled" | "timeout">((resolve) => {
    abort = () => resolve(timedOut() ? "timeout" : "cancelled");
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([
      promise.then((value) => ({ kind: "value" as const, value }), () => ({ kind: "error" as const })),
      stopped.then((kind) => ({ kind })),
    ]);
  } finally {
    if (abort !== undefined) signal.removeEventListener("abort", abort);
  }
};

export const readMcpRequestBody = async (
  request: IncomingMessage,
  signal: AbortSignal,
  timedOut: () => boolean,
  maximum: number,
  declared: number | undefined,
): Promise<McpBodyResult> => {
  let iterator: AsyncIterator<unknown>;
  try { iterator = request[Symbol.asyncIterator](); } catch { return { kind: "invalid" }; }
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await interruptMcp(Promise.resolve(iterator.next()), signal, timedOut);
    if (next.kind !== "value") {
      drainMcpRequest(request);
      return { kind: next.kind === "error" ? "invalid" : next.kind };
    }
    if (next.value.done) break;
    const raw = next.value.value;
    if (!(raw instanceof Uint8Array)) { drainMcpRequest(request); return { kind: "invalid" }; }
    length += raw.byteLength;
    if (length > maximum || declared !== undefined && length > declared) {
      drainMcpRequest(request); return { kind: "large" };
    }
    chunks.push(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength).slice());
  }
  if (declared !== undefined && declared !== length) return { kind: "invalid" };
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return { kind: "body", value: parseWorldJson(bytes, maximum) }; }
  catch (cause) {
    return cause instanceof WorldJsonCodecError && cause.code === "world_json_too_large"
      ? { kind: "large" } : { kind: "invalid" };
  }
};

export const toMcpWebRequest = (
  request: IncomingMessage,
  parsed: McpParsedHeaders,
  signal: AbortSignal,
  path: string,
): Request => {
  const safe = new Headers();
  for (const [name, value] of parsed) {
    if (!["connection", "content-length", "host", "transfer-encoding"].includes(name)) safe.set(name, value);
  }
  return new Request(`http://localhost${path}`, { method: request.method, headers: safe, signal });
};

export const readMcpResponse = async (
  response: Response,
  maximum: number,
  signal: AbortSignal,
  timedOut: () => boolean,
): Promise<McpReadResult> => {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > maximum)) {
    try { await response.body?.cancel(); } catch { /* Cleanup only. */ }
    return { kind: "large" };
  }
  if (response.body === null) return { kind: "bytes", bytes: new Uint8Array() };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let complete = false;
  try {
    while (true) {
      const next = await interruptMcp(reader.read(), signal, timedOut);
      if (next.kind !== "value") return { kind: next.kind === "error" ? "invalid" : next.kind };
      if (next.value.done) break;
      length += next.value.value.byteLength;
      if (length > maximum) return { kind: "large" };
      chunks.push(next.value.value.slice());
    }
    complete = true;
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { kind: "bytes", bytes };
  } finally {
    if (!complete || length > maximum || signal.aborted) try { await reader.cancel(); } catch { /* Cleanup only. */ }
    try { reader.releaseLock(); } catch { /* Cleanup only. */ }
  }
};

export const sanitizeMcpSdkFailure = async (response: Response): Promise<McpBoundaryResponse> => {
  try { await response.body?.cancel(); } catch { /* Never forward SDK diagnostics. */ }
  if (response.status === 403) return mcpBoundaryError(403, "forbidden");
  if (response.status === 404) return mcpBoundaryError(404, "session_not_found");
  if (response.status === 405) return mcpBoundaryError(405, "method_not_allowed");
  if (response.status === 406) return mcpBoundaryError(406, "not_acceptable");
  if (response.status === 409) return mcpBoundaryError(409, "session_conflict");
  if (response.status === 413) return mcpBoundaryError(413, "request_too_large");
  if (response.status === 415) return mcpBoundaryError(415, "unsupported_media_type");
  return response.status >= 500 ? mcpBoundaryError(500, "internal_error") : mcpBoundaryError(400, "invalid_request");
};

export const mcpBoundarySuccess = (
  status: number,
  sessionId: string | undefined,
  body: Uint8Array,
): McpBoundaryResponse => Object.freeze({
  status,
  headers: Object.freeze({ ...JSON_HEADERS, ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }) }),
  body,
});

export const writeMcpResponse = (response: ServerResponse, result: McpBoundaryResponse): boolean => {
  if (response.destroyed || response.writableEnded) return false;
  try {
    const output: Record<string, string> = { ...result.headers, "cache-control": "no-store" };
    if ([408, 413, 431].includes(result.status)) output.connection = "close";
    response.writeHead(result.status, output);
    response.end(result.body);
    return true;
  } catch { return false; }
};
