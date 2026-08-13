import { randomUUID } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { WORLD_HANDLER_LIMITS, type WorldAuthenticatingRequestHandler } from "./handler.js";
import { WORLD_JSON_LIMITS } from "./jsonCodec.js";
import { createWorldMcpProtocolServer } from "./mcp.js";
import {
  drainMcpRequest,
  interruptMcp,
  mcpBoundaryError,
  mcpBoundarySuccess,
  parseMcpAuthorization,
  parseMcpContentLength,
  parseMcpHeaders,
  readMcpRequestBody,
  readMcpResponse,
  sanitizeMcpSdkFailure,
  swallowMcpTerminalError,
  toMcpWebRequest,
  validMcpSessionId,
  writeMcpResponse,
  type McpBoundaryResponse,
} from "./nodeMcpBoundary.js";
import {
  createMcpSessionLifecycle,
  type McpSessionLease,
  type McpSessionReservation,
} from "./mcpSessionLifecycle.js";

export const WORLD_MCP_PATH = "/mcp";
export const WORLD_MCP_HTTP_LIMITS = Object.freeze({
  header_bytes: 8 * 1024,
  body_bytes: WORLD_JSON_LIMITS.request_bytes,
  deadline_ms: 5_000,
  idle_session_ms: 60_000,
  response_bytes: WORLD_HANDLER_LIMITS.response_bytes * 2 + 64 * 1024,
  sessions: 256,
});

export interface CreateWorldMcpRequestListenerInput {
  readonly handler: WorldAuthenticatingRequestHandler;
  readonly deadlineMs?: number;
  readonly maxHeaderBytes?: number;
  readonly maxBodyBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxSessions?: number;
  readonly idleSessionMs?: number;
  readonly sessionIdGenerator?: () => string;
}

export type WorldMcpRequestListener = RequestListener & { close(): Promise<void> };
type ProtocolSession = {
  readonly server: ReturnType<typeof createWorldMcpProtocolServer>;
  readonly transport: WebStandardStreamableHTTPServerTransport;
  close(): Promise<void>;
};

const protocolSession = (
  server: ReturnType<typeof createWorldMcpProtocolServer>,
  transport: WebStandardStreamableHTTPServerTransport,
  closeTimeoutMs: number,
): ProtocolSession => {
  let closing: Promise<void> | undefined;
  return {
    server,
    transport,
    close: (): Promise<void> => {
      closing ??= new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, closeTimeoutMs);
        void Promise.allSettled([server.close(), transport.close()]).then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      return closing;
    },
  };
};

/** Returns an unbound adapter; deployment owns createServer/listen and invokes close during shutdown. */
export const createWorldMcpRequestListener = (input: CreateWorldMcpRequestListenerInput): WorldMcpRequestListener => {
  const deadlineMs = input.deadlineMs ?? WORLD_MCP_HTTP_LIMITS.deadline_ms;
  const idleSessionMs = input.idleSessionMs ?? WORLD_MCP_HTTP_LIMITS.idle_session_ms;
  const headerMaximum = input.maxHeaderBytes ?? WORLD_MCP_HTTP_LIMITS.header_bytes;
  const bodyMaximum = input.maxBodyBytes ?? WORLD_MCP_HTTP_LIMITS.body_bytes;
  const responseMaximum = input.maxResponseBytes ?? WORLD_MCP_HTTP_LIMITS.response_bytes;
  const sessionMaximum = input.maxSessions ?? WORLD_MCP_HTTP_LIMITS.sessions;
  const generateSessionId = input.sessionIdGenerator ?? randomUUID;
  if (input.handler === null || typeof input.handler !== "object" || typeof input.handler.handle !== "function"
    || typeof input.handler.authenticate !== "function" || typeof generateSessionId !== "function"
    || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60_000
    || !Number.isSafeInteger(idleSessionMs) || idleSessionMs < 10 || idleSessionMs > WORLD_MCP_HTTP_LIMITS.idle_session_ms
    || !Number.isSafeInteger(headerMaximum) || headerMaximum < 128 || headerMaximum > WORLD_MCP_HTTP_LIMITS.header_bytes
    || !Number.isSafeInteger(bodyMaximum) || bodyMaximum < 1 || bodyMaximum > WORLD_MCP_HTTP_LIMITS.body_bytes
    || !Number.isSafeInteger(responseMaximum) || responseMaximum < 256 || responseMaximum > WORLD_MCP_HTTP_LIMITS.response_bytes
    || !Number.isSafeInteger(sessionMaximum) || sessionMaximum < 1 || sessionMaximum > WORLD_MCP_HTTP_LIMITS.sessions) {
    throw new TypeError("invalid world MCP request listener configuration");
  }
  const sessions = createMcpSessionLifecycle<ProtocolSession>({
    maxSessions: sessionMaximum,
    idleTtlMs: idleSessionMs,
    closeTimeoutMs: deadlineMs,
  });
  const active = new Map<Promise<void>, Readonly<{ cancellation: AbortController; response: ServerResponse }>>();
  let stopping = false;
  let closePromise: Promise<void> | undefined;

  const listener = ((request: IncomingMessage, response: ServerResponse): void => {
    if (stopping) {
      drainMcpRequest(request);
      writeMcpResponse(response, mcpBoundaryError(503, "listener_closed"));
      return;
    }
    const cancellation = new AbortController();
    let timedOut = false;
    let existingLease: McpSessionLease<ProtocolSession> | undefined;
    let freshLease: McpSessionLease<ProtocolSession> | undefined;
    let reservation: McpSessionReservation<ProtocolSession> | undefined;
    let candidate: ProtocolSession | undefined;
    const abandonFresh = async (): Promise<void> => {
      reservation?.release(); reservation = undefined;
      const committed = freshLease?.session;
      freshLease?.release(); freshLease = undefined;
      const uncommitted = candidate; candidate = undefined;
      if (committed !== undefined) await sessions.dispose(committed);
      else if (uncommitted !== undefined) await uncommitted.close();
    };
    const disposeCurrent = async (): Promise<void> => {
      if (freshLease !== undefined || candidate !== undefined) await abandonFresh();
      else if (existingLease !== undefined) await sessions.dispose(existingLease.session);
    };
    const deadlineAt = performance.now() + deadlineMs;
    const abort = (): void => { cancellation.abort(); };
    const close = (): void => { if (!response.writableEnded) cancellation.abort(); };
    const timer = setTimeout(() => { timedOut = true; cancellation.abort(); }, deadlineMs);
    timer.unref?.();
    const expired = (): boolean => {
      if (!timedOut && performance.now() >= deadlineAt) { timedOut = true; cancellation.abort(); }
      return timedOut;
    };
    request.once("aborted", abort); request.on("error", abort);
    response.once("close", close); response.on("error", abort);
    const route = async (): Promise<McpBoundaryResponse | undefined> => {
      if (request.url !== WORLD_MCP_PATH) { drainMcpRequest(request); return mcpBoundaryError(404, "not_found"); }
      const parsedHeaders = parseMcpHeaders(request, headerMaximum);
      if (parsedHeaders === undefined) { drainMcpRequest(request); return mcpBoundaryError(431, "invalid_headers"); }
      const requestedSessionId = parsedHeaders.get("mcp-session-id");
      if (requestedSessionId !== undefined && !validMcpSessionId(requestedSessionId)) {
        drainMcpRequest(request); return mcpBoundaryError(400, "invalid_session");
      }
      const bearer = parseMcpAuthorization(parsedHeaders.get("authorization"));
      if (bearer === undefined) { drainMcpRequest(request); return mcpBoundaryError(401, "unauthorized"); }
      let authentication: "authorized" | "unauthorized" | "internal_error";
      try {
        const preflight = input.handler.authenticate(bearer);
        authentication = preflight.kind === "authorized" || preflight.kind === "unauthorized"
          || preflight.kind === "internal_error" ? preflight.kind : "internal_error";
      } catch { authentication = "internal_error"; }
      if (authentication !== "authorized") {
        if (requestedSessionId !== undefined) await sessions.disposeExact(requestedSessionId, bearer);
        drainMcpRequest(request);
        return authentication === "internal_error" ? mcpBoundaryError(500, "internal_error") : mcpBoundaryError(401, "unauthorized");
      }
      if (requestedSessionId !== undefined) {
        const stored = sessions.lookup(requestedSessionId);
        if (stored === undefined) { drainMcpRequest(request); return mcpBoundaryError(404, "session_not_found"); }
        if (stored.bearer !== bearer) { drainMcpRequest(request); return mcpBoundaryError(401, "unauthorized"); }
        existingLease = sessions.acquire(requestedSessionId);
        if (existingLease === undefined) { drainMcpRequest(request); return mcpBoundaryError(404, "session_not_found"); }
      }
      if (request.method !== "POST" && request.method !== "DELETE") { drainMcpRequest(request); return mcpBoundaryError(405, "method_not_allowed"); }
      let parsedBody: unknown;
      if (request.method === "POST") {
        if (parsedHeaders.get("content-type") !== "application/json"
          && parsedHeaders.get("content-type") !== "application/json; charset=utf-8"
          || parsedHeaders.has("content-encoding")) { drainMcpRequest(request); return mcpBoundaryError(415, "unsupported_media_type"); }
        const declared = parseMcpContentLength(parsedHeaders.get("content-length"), bodyMaximum);
        if (declared === false) { drainMcpRequest(request); return mcpBoundaryError(413, "request_too_large"); }
        const body = await readMcpRequestBody(request, cancellation.signal, expired, bodyMaximum, declared);
        if (body.kind !== "body") {
          if (body.kind === "cancelled") { await disposeCurrent(); return undefined; }
          if (body.kind === "timeout") { await disposeCurrent(); return mcpBoundaryError(408, "request_timeout"); }
          if (body.kind === "large") return mcpBoundaryError(413, "request_too_large");
          return mcpBoundaryError(400, "invalid_request");
        }
        parsedBody = body.value;
      } else {
        const declared = parseMcpContentLength(parsedHeaders.get("content-length"), bodyMaximum);
        if (declared === false || declared !== undefined && declared !== 0 || parsedHeaders.has("transfer-encoding")) {
          drainMcpRequest(request); return mcpBoundaryError(400, "invalid_request");
        }
        drainMcpRequest(request);
      }
      if (expired()) { await disposeCurrent(); return mcpBoundaryError(408, "request_timeout"); }
      let session = existingLease?.session.value;
      const fresh = session === undefined;
      if (fresh) {
        if (requestedSessionId !== undefined) return mcpBoundaryError(404, "session_not_found");
        if (request.method !== "POST" || !isInitializeRequest(parsedBody)) return mcpBoundaryError(400, "invalid_session");
        reservation = sessions.reserve();
        if (reservation === undefined) return mcpBoundaryError(503, "session_capacity");
        let transport: WebStandardStreamableHTTPServerTransport | undefined;
        try {
          transport = new WebStandardStreamableHTTPServerTransport({
            enableJsonResponse: true,
            sessionIdGenerator: () => {
              let id: unknown;
              try { id = generateSessionId(); } catch { throw new Error("session id unavailable"); }
              if (!validMcpSessionId(id) || sessions.has(id)) throw new Error("session id unavailable");
              return id;
            },
            onsessioninitialized: (id) => {
              const committed = candidate === undefined ? undefined : reservation?.commit(id, bearer, candidate);
              reservation = undefined;
              if (committed === undefined) throw new Error("session unavailable");
              freshLease = committed;
            },
          });
          const server = createWorldMcpProtocolServer({ handler: input.handler, bearer });
          server.onerror = swallowMcpTerminalError;
          candidate = protocolSession(server, transport, deadlineMs);
          session = candidate;
        } catch {
          reservation?.release(); reservation = undefined;
          try { await transport?.close(); } catch { /* Boundary cleanup only. */ }
          return mcpBoundaryError(500, "internal_error");
        }
        if (session === undefined) { await abandonFresh(); return mcpBoundaryError(500, "internal_error"); }
        const connected = await interruptMcp(session.server.connect(session.transport), cancellation.signal, expired);
        if (connected.kind !== "value") {
          await abandonFresh();
          return connected.kind === "timeout" ? mcpBoundaryError(408, "request_timeout")
            : connected.kind === "cancelled" ? undefined : mcpBoundaryError(500, "internal_error");
        }
        if (expired()) { await abandonFresh(); return mcpBoundaryError(408, "request_timeout"); }
      }
      if (session === undefined) { await abandonFresh(); return mcpBoundaryError(500, "internal_error"); }
      const handled = await interruptMcp(
        session.transport.handleRequest(toMcpWebRequest(request, parsedHeaders, cancellation.signal, WORLD_MCP_PATH), { parsedBody }),
        cancellation.signal,
        expired,
      );
      if (handled.kind !== "value") {
        await disposeCurrent();
        return handled.kind === "timeout" ? mcpBoundaryError(408, "request_timeout")
          : handled.kind === "cancelled" ? undefined : mcpBoundaryError(500, "internal_error");
      }
      if (expired()) { await disposeCurrent(); return mcpBoundaryError(408, "request_timeout"); }
      if (handled.value.status < 200 || handled.value.status >= 300) {
        const failure = await sanitizeMcpSdkFailure(handled.value);
        if (fresh) await abandonFresh();
        return failure;
      }
      const read = await readMcpResponse(handled.value, responseMaximum, cancellation.signal, expired);
      if (read.kind !== "bytes") {
        await disposeCurrent();
        return read.kind === "timeout" ? mcpBoundaryError(408, "request_timeout")
          : read.kind === "cancelled" ? undefined : mcpBoundaryError(500, "internal_error");
      }
      if (expired()) { await disposeCurrent(); return mcpBoundaryError(408, "request_timeout"); }
      if (fresh && (freshLease === undefined || session.transport.sessionId === undefined)) {
        await abandonFresh();
        return mcpBoundaryError(500, "internal_error");
      }
      if (request.method === "DELETE" && existingLease !== undefined) await sessions.dispose(existingLease.session);
      return mcpBoundarySuccess(
        handled.value.status,
        request.method === "DELETE" ? undefined : session.transport.sessionId,
        read.bytes,
      );
    };

    let task!: Promise<void>;
    task = (async () => {
      try {
        const result = await route();
        const wrote = result !== undefined && (!cancellation.signal.aborted || timedOut) && writeMcpResponse(response, result);
        if (freshLease !== undefined || candidate !== undefined) {
          if (wrote && result !== undefined && result.status >= 200 && result.status < 300) {
            freshLease?.release(); freshLease = undefined; candidate = undefined;
          } else await abandonFresh();
        }
      } catch {
        await abandonFresh();
        if (!cancellation.signal.aborted || timedOut) {
          writeMcpResponse(response, timedOut ? mcpBoundaryError(408, "request_timeout") : mcpBoundaryError(500, "internal_error"));
        }
      }
    })().finally(() => {
      existingLease?.release(); existingLease = undefined;
      clearTimeout(timer);
      if (cancellation.signal.aborted && !response.writableEnded && !response.destroyed) response.destroy();
      request.off("aborted", abort); request.off("error", abort);
      response.off("close", close); response.off("error", abort);
      request.on("error", swallowMcpTerminalError); response.on("error", swallowMcpTerminalError);
      active.delete(task);
    });
    active.set(task, { cancellation, response });
    void task;
  }) as WorldMcpRequestListener;

  listener.close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    stopping = true;
    for (const item of active.values()) {
      item.cancellation.abort();
      if (!item.response.writableEnded && !item.response.destroyed) item.response.destroy();
    }
    const tracked = [...active.keys()];
    closePromise = (async () => {
      await Promise.allSettled([sessions.close(), ...tracked]);
    })();
    return closePromise;
  };
  return listener;
};
