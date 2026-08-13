import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import type { WorldHandlerRequest, WorldRequestHandler } from "./handler.js";
import { createWorldJsonServer } from "./jsonServer.js";
import { createWorldJsonRequestListener } from "./nodeJsonListener.js";
import { parseWorldJson } from "./jsonCodec.js";

class Response extends EventEmitter {
  public destroyed = false;
  public writableEnded = false;
  public status = 0;
  public headers: Record<string, string> = {};
  public body = new Uint8Array();
  public writeHeadCalls = 0;
  public endCalls = 0;
  private resolve!: () => void;
  public readonly ended = new Promise<void>((resolve) => { this.resolve = resolve; });

  public writeHead(status: number, headers: Record<string, string>): this {
    this.writeHeadCalls += 1;
    this.status = status;
    this.headers = headers;
    return this;
  }

  public end(body?: Uint8Array): this {
    this.endCalls += 1;
    this.body = body?.slice() ?? new Uint8Array();
    this.writableEnded = true;
    this.resolve();
    return this;
  }
}

const incoming = (body: string): IncomingMessage => {
  const request = Readable.from([new TextEncoder().encode(body)]) as Readable & {
    method: string; url: string; rawHeaders: string[]; complete: boolean;
  };
  request.method = "POST";
  request.url = "/v1/world/status";
  request.rawHeaders = ["Authorization", "Bearer red-token", "Content-Type", "application/json"];
  request.complete = false;
  return request as unknown as IncomingMessage;
};
const settled = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
};

const pendingIncoming = (): IncomingMessage => {
  const request = new Readable({ read: () => {} }) as Readable & {
    method: string; url: string; rawHeaders: string[]; complete: boolean;
  };
  request.method = "POST";
  request.url = "/v1/world/status";
  request.rawHeaders = ["Authorization", "Bearer red-token", "Content-Type", "application/json"];
  request.complete = false;
  return request as unknown as IncomingMessage;
};

test("unbound Node listener maps raw request bytes and writes the route response", async () => {
  const calls: unknown[] = [];
  const handler: WorldRequestHandler = Object.freeze({ handle: (request: WorldHandlerRequest) => {
    calls.push(request);
    return { status: 200 as const, body: new TextEncoder().encode('{"ok":true}') };
  } });
  const listener = createWorldJsonRequestListener({ server: createWorldJsonServer({ handler }) });
  const response = new Response();
  const request = incoming('{"decision_token":"decision-red"}');
  listener(request, response as unknown as ServerResponse);
  await response.ended;
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
  assert.deepEqual(parseWorldJson(response.body), { ok: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    operation: "status",
    bearer: "red-token",
    body: new TextEncoder().encode('{"decision_token":"decision-red"}'),
  });
});

test("Node listener returns a bounded deadline response without dispatching a slow body", async () => {
  let calls = 0;
  const handler: WorldRequestHandler = Object.freeze({ handle: () => {
    calls += 1;
    return { status: 200 as const, body: new TextEncoder().encode("{}") };
  } });
  const listener = createWorldJsonRequestListener({ server: createWorldJsonServer({ handler, deadlineMs: 10 }) });
  const response = new Response();
  listener(pendingIncoming(), response as unknown as ServerResponse);
  await response.ended;
  assert.equal(response.status, 408);
  assert.equal(response.headers.connection, "close");
  assert.equal(calls, 0);
});

test("Node listener suppresses writes when the request disconnects before dispatch", async () => {
  let calls = 0;
  const handler: WorldRequestHandler = Object.freeze({ handle: () => {
    calls += 1;
    return { status: 200 as const, body: new TextEncoder().encode("{}") };
  } });
  const listener = createWorldJsonRequestListener({ server: createWorldJsonServer({ handler, deadlineMs: 50 }) });
  const response = new Response();
  const request = pendingIncoming();
  listener(request, response as unknown as ServerResponse);
  request.emit("aborted");
  await settled();
  assert.equal(response.writableEnded, false);
  assert.equal(response.writeHeadCalls, 0);
  assert.equal(calls, 0);
});

test("Node listener safely handles request errors before dispatch and after completion", async () => {
  let calls = 0;
  const handler: WorldRequestHandler = Object.freeze({ handle: () => {
    calls += 1;
    return { status: 200 as const, body: new TextEncoder().encode("{}") };
  } });
  const listener = createWorldJsonRequestListener({ server: createWorldJsonServer({ handler, deadlineMs: 50 }) });

  const earlyResponse = new Response();
  const earlyRequest = pendingIncoming();
  listener(earlyRequest, earlyResponse as unknown as ServerResponse);
  assert.doesNotThrow(() => earlyRequest.emit("error", new Error("secret-canary-early")));
  await settled();
  assert.equal(earlyResponse.writeHeadCalls, 0);
  assert.equal(calls, 0);

  const lateResponse = new Response();
  const lateRequest = incoming('{"decision_token":"decision-red"}');
  listener(lateRequest, lateResponse as unknown as ServerResponse);
  await lateResponse.ended;
  await settled();
  assert.doesNotThrow(() => lateRequest.emit("error", new Error("secret-canary-late")));
  assert.equal(lateRequest.listenerCount("aborted"), 0);
  // Readable's async iterator retains one error guard; the listener adds one terminal guard.
  assert.equal(lateRequest.listenerCount("error"), 2);
  assert.equal(lateResponse.endCalls, 1);
  assert.equal(calls, 1);
});

test("Node listener safely suppresses dispatch and writes on response error or close", async () => {
  let calls = 0;
  const handler: WorldRequestHandler = Object.freeze({ handle: () => {
    calls += 1;
    return { status: 200 as const, body: new TextEncoder().encode("{}") };
  } });
  const listener = createWorldJsonRequestListener({ server: createWorldJsonServer({ handler, deadlineMs: 50 }) });
  for (const event of ["error", "close"] as const) {
    const response = new Response();
    listener(pendingIncoming(), response as unknown as ServerResponse);
    assert.doesNotThrow(() => event === "error"
      ? response.emit(event, new Error("secret-canary-response"))
      : response.emit(event));
    await settled();
    if (event === "close") assert.doesNotThrow(() => response.emit("error", new Error("secret-canary-after-close")));
    assert.equal(response.listenerCount("close"), 0);
    assert.equal(response.listenerCount("error"), 1);
    assert.equal(response.writeHeadCalls, 0);
    assert.equal(response.endCalls, 0);
  }
  assert.equal(calls, 0);
});
