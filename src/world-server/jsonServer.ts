import { WORLD_HANDLER_LIMITS, WORLD_OPTIONAL_REQUEST_OPERATIONS, WORLD_REQUEST_OPERATIONS, type WorldRequestHandler } from "./handler.js";
import { WORLD_JSON_LIMITS } from "./jsonCodec.js";

export const WORLD_JSON_BASE_PATH = "/v1/world";
export const WORLD_READY_PATH = "/readyz";
export const WORLD_JSON_SERVER_LIMITS = Object.freeze({
  header_bytes: 8 * 1024,
  body_bytes: WORLD_JSON_LIMITS.request_bytes,
  deadline_ms: 5_000,
});

export interface WorldJsonServerRequest {
  readonly method: unknown;
  readonly path: unknown;
  readonly headers: unknown;
  readonly body?: AsyncIterable<Uint8Array>;
  readonly signal?: AbortSignal;
}
export interface WorldJsonServerResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}
export interface CreateWorldJsonServerInput {
  readonly handler: WorldRequestHandler;
  readonly deadlineMs?: number;
  readonly maxHeaderBytes?: number;
  readonly maxBodyBytes?: number;
}
export interface WorldJsonServer {
  handle(request: WorldJsonServerRequest): Promise<WorldJsonServerResponse | undefined>;
}

type Headers = ReadonlyMap<string, string>;
type BodyResult =
  | Readonly<{ kind: "body"; bytes: Uint8Array }>
  | Readonly<{ kind: "cancelled" | "invalid" | "large" | "timeout" }>;
const UTF8 = new TextEncoder();
const JSON_HEADERS = Object.freeze({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
const error = (status: number, code: string): WorldJsonServerResponse => Object.freeze({
  status,
  headers: JSON_HEADERS,
  body: UTF8.encode(JSON.stringify({ error: { code } })),
});
const ready = (): WorldJsonServerResponse => Object.freeze({
  status: 200,
  headers: JSON_HEADERS,
  body: UTF8.encode(JSON.stringify({ status: "ready" })),
});
const route = (path: unknown): string | "ready" | undefined => {
  if (path === WORLD_READY_PATH) return "ready";
  if (typeof path !== "string" || !path.startsWith(`${WORLD_JSON_BASE_PATH}/`)) return undefined;
  const operation = path.slice(WORLD_JSON_BASE_PATH.length + 1);
  return [...WORLD_REQUEST_OPERATIONS, ...WORLD_OPTIONAL_REQUEST_OPERATIONS].includes(operation as never)
    ? operation : undefined;
};
const headers = (value: unknown, maximum: number): Headers | undefined => {
  if (!Array.isArray(value)) return undefined;
  let size = 0;
  const output = new Map<string, string>();
  for (const entry of value as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string") return undefined;
    const name = entry[0].toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(name) || /[\u0000-\u001f\u007f]/u.test(entry[1]) || output.has(name)) return undefined;
    size += UTF8.encode(name).byteLength + UTF8.encode(entry[1]).byteLength + 4;
    if (size > maximum) return undefined;
    output.set(name, entry[1]);
  }
  return output;
};
const authorization = (value: string | undefined): string | undefined => {
  if (value === undefined || value.length > WORLD_HANDLER_LIMITS.bearer_code_units + 7) return undefined;
  const match = /^Bearer ([A-Za-z0-9._~+\/-]+={0,2})$/u.exec(value);
  return match?.[1];
};
const contentLength = (value: string | undefined, maximum: number): number | undefined | false => {
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : false;
};
const stop = (iterator: AsyncIterator<Uint8Array>): void => {
  try {
    const result = iterator.return?.();
    if (result !== undefined) void Promise.resolve(result).catch(() => {});
  } catch { /* Nothing crosses the transport boundary. */ }
};
const body = async (source: AsyncIterable<Uint8Array> | undefined, signal: AbortSignal | undefined,
  deadlineAt: number, maximum: number, declared: number | undefined): Promise<BodyResult> => {
  if (source === undefined || source === null || typeof source[Symbol.asyncIterator] !== "function") return { kind: "invalid" };
  let iterator: AsyncIterator<Uint8Array>;
  try { iterator = source[Symbol.asyncIterator](); } catch { return { kind: "invalid" }; }
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    if (signal?.aborted) { stop(iterator); return { kind: "cancelled" }; }
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) { stop(iterator); return { kind: "timeout" }; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const interrupted = new Promise<"cancelled" | "timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), remaining);
      if (signal !== undefined) {
        abort = () => resolve("cancelled");
        signal.addEventListener("abort", abort, { once: true });
      }
    });
    let next: IteratorResult<Uint8Array> | "cancelled" | "timeout";
    try { next = await Promise.race([iterator.next(), interrupted]); } catch { next = "cancelled"; }
    if (timer !== undefined) clearTimeout(timer);
    if (signal !== undefined && abort !== undefined) signal.removeEventListener("abort", abort);
    if (next === "cancelled" || next === "timeout") { stop(iterator); return { kind: next }; }
    if (next.done) break;
    if (!(next.value instanceof Uint8Array)) { stop(iterator); return { kind: "invalid" }; }
    length += next.value.byteLength;
    if (length > maximum || declared !== undefined && length > declared) { stop(iterator); return { kind: "large" }; }
    chunks.push(new Uint8Array(next.value.buffer, next.value.byteOffset, next.value.byteLength).slice());
  }
  if (declared !== undefined && declared !== length) return { kind: "invalid" };
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return { kind: "body", bytes: output };
};

export const createWorldJsonServer = (input: CreateWorldJsonServerInput): WorldJsonServer => {
  const deadlineMs = input.deadlineMs ?? WORLD_JSON_SERVER_LIMITS.deadline_ms;
  const headerMaximum = input.maxHeaderBytes ?? WORLD_JSON_SERVER_LIMITS.header_bytes;
  const bodyMaximum = input.maxBodyBytes ?? WORLD_JSON_SERVER_LIMITS.body_bytes;
  if (input.handler === null || typeof input.handler !== "object" || typeof input.handler.handle !== "function"
    || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60_000
    || !Number.isSafeInteger(headerMaximum) || headerMaximum < 128 || headerMaximum > WORLD_JSON_SERVER_LIMITS.header_bytes
    || !Number.isSafeInteger(bodyMaximum) || bodyMaximum < 1 || bodyMaximum > WORLD_JSON_SERVER_LIMITS.body_bytes) {
    throw new TypeError("invalid world JSON server configuration");
  }
  const handler = input.handler;
  return Object.freeze({
    handle: async (request: WorldJsonServerRequest): Promise<WorldJsonServerResponse | undefined> => {
      const selected = route(request.path);
      if (selected === undefined) return error(404, "not_found");
      const parsedHeaders = headers(request.headers, headerMaximum);
      if (parsedHeaders === undefined) return error(431, "invalid_headers");
      if (selected === "ready") return request.method === "GET" ? ready() : error(405, "method_not_allowed");
      if (request.method !== "POST") return error(405, "method_not_allowed");
      if (parsedHeaders.get("content-type") !== "application/json"
        && parsedHeaders.get("content-type") !== "application/json; charset=utf-8") return error(415, "unsupported_media_type");
      if (parsedHeaders.has("content-encoding")) return error(415, "unsupported_media_type");
      const bearer = authorization(parsedHeaders.get("authorization"));
      if (bearer === undefined) return error(401, "unauthorized");
      const declared = contentLength(parsedHeaders.get("content-length"), bodyMaximum);
      if (declared === false) return error(413, "request_too_large");
      const deadlineAt = Date.now() + deadlineMs;
      const read = await body(request.body, request.signal, deadlineAt, bodyMaximum, declared);
      if (read.kind !== "body") {
        if (read.kind === "cancelled") return undefined;
        if (read.kind === "timeout") return error(408, "request_timeout");
        if (read.kind === "large") return error(413, "request_too_large");
        return error(400, "invalid_request");
      }
      if (request.signal?.aborted) return undefined;
      if (Date.now() >= deadlineAt) return error(408, "request_timeout");
      const response = handler.handle({ operation: selected, bearer, body: read.bytes });
      if (request.signal?.aborted) return undefined;
      if (Date.now() >= deadlineAt) return error(408, "request_timeout");
      return Object.freeze({ status: response.status, headers: JSON_HEADERS, body: response.body });
    },
  });
};
