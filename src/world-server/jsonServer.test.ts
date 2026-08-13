import assert from "node:assert/strict";
import test from "node:test";

import type { WorldHandlerRequest, WorldRequestHandler } from "./handler.js";
import { createWorldJsonServer } from "./jsonServer.js";
import { parseWorldJson } from "./jsonCodec.js";

const UTF8 = new TextEncoder();
const chunks = async function* (value: string): AsyncGenerator<Uint8Array> { yield UTF8.encode(value); };
const request = (path: string, body = '{"decision_token":"decision-red"}') => ({
  method: "POST",
  path,
  headers: [["authorization", "Bearer red-token"], ["content-type", "application/json"]] as const,
  body: chunks(body),
});

test("routes exact /v1/world operation paths and rejects method/path/content-type drift", async () => {
  const calls: unknown[] = [];
  const handler: WorldRequestHandler = Object.freeze({ handle: (value: WorldHandlerRequest) => {
    calls.push(value);
    return { status: 200 as const, body: UTF8.encode('{"ok":true}') };
  } });
  const server = createWorldJsonServer({ handler });
  const response = await server.handle(request("/v1/world/status"));
  assert.equal(response?.status, 200);
  assert.deepEqual(parseWorldJson(response!.body), { ok: true });
  assert.deepEqual(calls, [{ operation: "status", bearer: "red-token", body: UTF8.encode('{"decision_token":"decision-red"}') }]);
  assert.equal((await server.handle({ ...request("/v1/world/status"), method: "GET" }))?.status, 405);
  assert.equal((await server.handle(request("/v1/world/status/")))?.status, 404);
  assert.equal((await server.handle(request("/v1/world/decide")))?.status, 404);
  assert.equal((await server.handle({ ...request("/v1/world/status"), headers: [["authorization", "Bearer red-token"], ["content-type", "Application/JSON"]] }))?.status, 415);
  assert.equal(calls.length, 1);
});

test("serves /readyz without reading a body or invoking the agent handler", async () => {
  let calls = 0, reads = 0;
  const handler: WorldRequestHandler = Object.freeze({ handle: () => { calls += 1; throw new Error("must not run"); } });
  const body = { async *[Symbol.asyncIterator]() { reads += 1; yield UTF8.encode("secret-canary"); } };
  const server = createWorldJsonServer({ handler });
  const response = await server.handle({ method: "GET", path: "/readyz", headers: [], body });
  assert.equal(response?.status, 200);
  assert.deepEqual(parseWorldJson(response!.body), { status: "ready" });
  assert.equal(calls, 0);
  assert.equal(reads, 0);
});

test("bounds headers and bodies and enforces exact bearer/content length syntax", async () => {
  let calls = 0;
  const handler: WorldRequestHandler = Object.freeze({ handle: () => {
    calls += 1;
    return { status: 200 as const, body: UTF8.encode("{}") };
  } });
  const server = createWorldJsonServer({ handler, maxHeaderBytes: 128, maxBodyBytes: 64 });
  const variants = [
    { ...request("/v1/world/status"), headers: [["authorization", "bearer red-token"], ["content-type", "application/json"]], status: 401 },
    { ...request("/v1/world/status"), headers: [["authorization", "Bearer red-token"], ["authorization", "Bearer blue-token"], ["content-type", "application/json"]], status: 431 },
    { ...request("/v1/world/status"), headers: [["authorization", "Bearer red-token"], ["content-type", "application/json"], ["content-encoding", "gzip"]], status: 415 },
    { ...request("/v1/world/status"), headers: [["authorization", "Bearer red-token"], ["content-type", "application/json"], ["x-long", "x".repeat(128)]], status: 431 },
    { ...request("/v1/world/status"), headers: [["authorization", "Bearer red-token"], ["content-type", "application/json"], ["content-length", "1"]], status: 413 },
  ];
  for (const variant of variants) assert.equal((await server.handle(variant))?.status, variant.status);
  const oversized = await server.handle({ ...request("/v1/world/status"), body: chunks("x".repeat(65)) });
  assert.equal(oversized?.status, 413);
  assert.equal(calls, 0);
});

test("times out a slow body and suppresses dispatch after disconnect", async () => {
  let calls = 0, returns = 0;
  const handler: WorldRequestHandler = Object.freeze({ handle: () => {
    calls += 1;
    return { status: 200 as const, body: UTF8.encode("{}") };
  } });
  const pending = (): AsyncIterable<Uint8Array> => ({
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
      return: async () => { returns += 1; return { done: true, value: undefined }; },
    }),
  });
  const server = createWorldJsonServer({ handler, deadlineMs: 10 });
  const timed = await server.handle({ ...request("/v1/world/status"), body: pending() });
  assert.equal(timed?.status, 408);

  const cancellation = new AbortController();
  const disconnected = server.handle({ ...request("/v1/world/status"), body: pending(), signal: cancellation.signal });
  cancellation.abort();
  assert.equal(await disconnected, undefined);
  assert.equal(calls, 0);
  assert.equal(returns, 2);
});
