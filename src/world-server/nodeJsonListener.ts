import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

import { WORLD_JSON_SERVER_LIMITS, type WorldJsonServer, type WorldJsonServerResponse } from "./jsonServer.js";

export interface CreateWorldJsonRequestListenerInput {
  readonly server: WorldJsonServer;
}

const requestHeaders = (request: IncomingMessage): readonly (readonly [string, string])[] => {
  if (request.rawHeaders.length % 2 !== 0) return Object.freeze([["", ""]] as const);
  const output: [string, string][] = [];
  let size = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name === undefined || value === undefined) return Object.freeze([["", ""]] as const);
    size += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (size > WORLD_JSON_SERVER_LIMITS.header_bytes) return Object.freeze([["", ""]] as const);
    output.push([name, value]);
  }
  return Object.freeze(output);
};

const requestBody = (request: IncomingMessage): AsyncIterable<Uint8Array> => Object.freeze({
  [Symbol.asyncIterator]: (): AsyncIterator<Uint8Array> => {
    const source = request[Symbol.asyncIterator]();
    return Object.freeze({
      next: async (): Promise<IteratorResult<Uint8Array>> => {
        const result = await source.next();
        return result.done ? { done: true, value: undefined } : { done: false, value: result.value as Uint8Array };
      },
      return: async (): Promise<IteratorResult<Uint8Array>> => {
        request.resume();
        return { done: true, value: undefined };
      },
    });
  },
});

const fallback = (): WorldJsonServerResponse => Object.freeze({
  status: 500,
  headers: Object.freeze({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }),
  body: new TextEncoder().encode(JSON.stringify({ error: { code: "internal_error" } })),
});
const swallowTerminalError = (): void => {};

/** Returns an unbound listener; socket/server lifecycle remains with the caller. */
export const createWorldJsonRequestListener = (input: CreateWorldJsonRequestListenerInput): RequestListener => {
  if (input.server === null || typeof input.server !== "object" || typeof input.server.handle !== "function") {
    throw new TypeError("invalid world JSON request listener configuration");
  }
  const server = input.server;
  return (request: IncomingMessage, response: ServerResponse): void => {
    const cancellation = new AbortController();
    const disconnected = (): void => { cancellation.abort(); };
    const closed = (): void => { if (!response.writableEnded) cancellation.abort(); };
    request.once("aborted", disconnected);
    request.on("error", disconnected);
    response.once("close", closed);
    response.on("error", disconnected);
    void (async () => {
      let result: WorldJsonServerResponse | undefined;
      try {
        result = await server.handle({
          method: request.method,
          path: request.url,
          headers: requestHeaders(request),
          body: requestBody(request),
          signal: cancellation.signal,
        });
      } catch { result = fallback(); }
      if (result === undefined || cancellation.signal.aborted || response.destroyed || response.writableEnded) return;
      if (!request.complete) request.resume();
      const close = result.status === 408 || result.status === 413 || result.status === 431;
      try {
        response.writeHead(result.status, { ...result.headers, ...(close ? { connection: "close" } : {}) });
        response.end(result.body);
      } catch { cancellation.abort(); }
    })().finally(() => {
      request.off("aborted", disconnected);
      request.off("error", disconnected);
      response.off("close", closed);
      response.off("error", disconnected);
      // A stream can report an asynchronous terminal error after end/cleanup.
      // Closure-free guards keep those events bounded without retaining request state.
      request.on("error", swallowTerminalError);
      response.on("error", swallowTerminalError);
    });
  };
};
