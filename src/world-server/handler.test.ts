import assert from "node:assert/strict";
import test from "node:test";

import { encodeWorldActEnvelope } from "../world/actEnvelope.js";
import { WORLD_ACTION_RESULT_PAGE_REQUEST_VERSION } from "../world/actionResultLedger.js";
import { registerWorldBoundaryObserver } from "../world/boundaryObserver.js";
import { WorldRuntimeError } from "../world/ledger.js";
import type { AuthenticatedWorldContext, WorldRuntime } from "../world/runtime.js";
import { createWorldRequestHandler, type WorldHandlerResponse } from "./handler.js";
import { parseWorldJson, WORLD_JSON_LIMITS } from "./jsonCodec.js";

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const decode = (response: WorldHandlerResponse): unknown => parseWorldJson(response.body);

const recordingRuntime = () => {
  const calls: { operation: string; context: AuthenticatedWorldContext; request?: unknown }[] = [];
  const called = (operation: string, context: AuthenticatedWorldContext, request?: unknown) => {
    calls.push({ operation, context, ...(request === undefined ? {} : { request }) });
    return { operation };
  };
  const runtime = {
    status: (context: AuthenticatedWorldContext) => called("status", context),
    capabilities: (context: AuthenticatedWorldContext) => called("capabilities", context),
    observe: (context: AuthenticatedWorldContext, request: unknown) => called("observe", context, request),
    affordances: (context: AuthenticatedWorldContext) => called("affordances", context),
    act: (context: AuthenticatedWorldContext, request: Uint8Array) => called("act", context, request),
    ledger: (context: AuthenticatedWorldContext, request: unknown) => called("ledger", context, request),
  } as unknown as WorldRuntime;
  return { runtime, calls };
};

test("dispatches all six operations with bearer-derived identity", () => {
  const fixture = recordingRuntime();
  const handler = createWorldRequestHandler({
    runtime: fixture.runtime,
    resolveBearer: (value) => value === "red-bearer" ? "principal-red" : undefined,
  });
  const cases = [
    ["status", { decision_token: "decision-red" }],
    ["capabilities", { decision_token: "decision-red" }],
    ["observe", { decision_token: "decision-red", sense: "world://pitch/sense/vision" }],
    ["affordances", { decision_token: "decision-red" }],
    ["act", { decision_token: "decision-red", request_id: "request-1", affordance: "world://pitch/affordance/kick", target: "world://pitch/entity/ball", input: { force: 1 } }],
    ["ledger", { decision_token: "decision-red", version: WORLD_ACTION_RESULT_PAGE_REQUEST_VERSION, limit: 10 }],
  ] as const;
  for (const [operation, body] of cases) {
    const response = handler.handle({ operation, bearer: "red-bearer", body: encode(body) });
    assert.equal(response.status, 200);
    assert.deepEqual(decode(response), { operation });
  }
  assert.deepEqual(fixture.calls.map((call) => call.operation), cases.map(([operation]) => operation));
  assert.ok(fixture.calls.every((call) => call.context.principal === "principal-red" && call.context.decisionToken === "decision-red"));
  assert.deepEqual(fixture.calls[2]!.request, { sense: "world://pitch/sense/vision" });
  assert.deepEqual(fixture.calls[4]!.request, encodeWorldActEnvelope({
    request_id: "request-1",
    affordance: "world://pitch/affordance/kick",
    target: "world://pitch/entity/ball",
    input: { force: 1 },
  }));
  assert.deepEqual(fixture.calls[5]!.request, { version: WORLD_ACTION_RESULT_PAGE_REQUEST_VERSION, limit: 10 });
});

test("captures exact authenticated native request and response bytes without bearer material", () => {
  const fixture = recordingRuntime();
  const captured: unknown[] = [];
  registerWorldBoundaryObserver(fixture.runtime, {
    begin: (input) => {
      captured.push(input);
      return { complete: (response) => { captured.push(response); } };
    },
  });
  const handler = createWorldRequestHandler({
    runtime: fixture.runtime,
    resolveBearer: (value) => value === "secret-bearer" ? "principal-red" : undefined,
  });
  const body = encode({ decision_token: "private-decision", sense: "world://pitch/sense/vision" });
  const response = handler.handle({ operation: "observe", bearer: "secret-bearer", body });
  assert.equal(response.status, 200);
  assert.deepEqual(captured, [{
    operation: "observe",
    principal: "principal-red",
    request: encode({ sense: "world://pitch/sense/vision" }),
  }, {
    status: 200,
    response: response.body,
  }]);
  assert.equal(JSON.stringify(captured).includes("secret-bearer"), false);
  assert.equal(JSON.stringify(captured).includes("private-decision"), false);
});

test("rejects caller identity, extra fields, unknown operations, and bad bearer values before dispatch", () => {
  const fixture = recordingRuntime();
  let resolutions = 0;
  const handler = createWorldRequestHandler({ runtime: fixture.runtime, resolveBearer: () => { resolutions += 1; return "principal-red"; } });
  const cases = [
    { operation: "status", bearer: "red-bearer", body: { decision_token: "decision-red", principal: "principal-blue" }, status: 400 },
    { operation: "observe", bearer: "red-bearer", body: { decision_token: "decision-red", sense: "sense", extra: true }, status: 400 },
    { operation: "decide", bearer: "red-bearer", body: { decision_token: "decision-red" }, status: 404 },
    { operation: "status", bearer: "bad bearer", body: { decision_token: "decision-red" }, status: 401 },
  ];
  for (const item of cases) {
    const response = handler.handle({ operation: item.operation, bearer: item.bearer, body: encode(item.body) });
    assert.equal(response.status, item.status);
  }
  assert.equal(resolutions, 2);
  assert.equal(fixture.calls.length, 0);
});

test("rejects malformed result-ledger values before runtime dispatch", () => {
  const fixture = recordingRuntime();
  const handler = createWorldRequestHandler({ runtime: fixture.runtime, resolveBearer: () => "principal-red" });
  for (const body of [
    { decision_token: "decision-red", version: WORLD_ACTION_RESULT_PAGE_REQUEST_VERSION, limit: 0 },
    { decision_token: "decision-red", version: WORLD_ACTION_RESULT_PAGE_REQUEST_VERSION, limit: "10" },
    { decision_token: "decision-red", after: 0 },
  ]) {
    const response = handler.handle({ operation: "ledger", bearer: "red-bearer", body: encode(body) });
    assert.equal(response.status, 400);
  }
  assert.equal(fixture.calls.length, 0);
});

test("rejects hostile handler request containers without invoking traps or throwing", () => {
  const fixture = recordingRuntime();
  const handler = createWorldRequestHandler({ runtime: fixture.runtime, resolveBearer: () => "principal-red" });
  let traps = 0;
  const hostile = new Proxy({ operation: "status", bearer: "red-bearer", body: encode({ decision_token: "decision-red" }) }, {
    get: () => { traps += 1; throw new Error("secret-canary-proxy"); },
    ownKeys: () => { traps += 1; throw new Error("secret-canary-proxy"); },
  });
  const accessor = Object.defineProperty({ bearer: "red-bearer", body: encode({ decision_token: "decision-red" }) }, "operation", {
    enumerable: true,
    get: () => { traps += 1; throw new Error("secret-canary-accessor"); },
  });
  for (const value of [hostile, accessor]) {
    const response = handler.handle(value as never);
    assert.equal(response.status, 400);
    assert.ok(response.body.byteLength < 128);
    assert.equal(new TextDecoder().decode(response.body).includes("secret-canary"), false);
  }
  assert.equal(traps, 0);
  assert.equal(fixture.calls.length, 0);
});

test("maps malformed and oversized bodies to bounded redacted errors", () => {
  const fixture = recordingRuntime();
  const handler = createWorldRequestHandler({ runtime: fixture.runtime, resolveBearer: () => "principal-red" });
  for (const body of [
    new TextEncoder().encode('{"decision_token":"secret-canary","decision_token":"other"}'),
    new TextEncoder().encode('{"decision_token":"secret-canary"} trailing'),
    new Uint8Array([0xc3, 0x28]),
  ]) {
    const response = handler.handle({ operation: "status", bearer: "red-bearer", body });
    assert.equal(response.status, 400);
    assert.ok(response.body.byteLength < 128);
    assert.equal(new TextDecoder().decode(response.body).includes("secret-canary"), false);
  }
  const large = handler.handle({ operation: "status", bearer: "red-bearer", body: new Uint8Array(WORLD_JSON_LIMITS.request_bytes + 1) });
  assert.equal(large.status, 413);
  assert.ok(large.body.byteLength < 128);
  assert.equal(fixture.calls.length, 0);
});

test("redacts runtime and resolver failures and bounds oversized results", () => {
  const denied = recordingRuntime();
  denied.runtime.status = (() => { throw new WorldRuntimeError("world_runtime_denied"); }) as never;
  const deniedHandler = createWorldRequestHandler({ runtime: denied.runtime, resolveBearer: () => "principal-red" });
  assert.equal(deniedHandler.handle({ operation: "status", bearer: "red-bearer", body: encode({ decision_token: "decision-red" }) }).status, 403);

  const failed = recordingRuntime();
  failed.runtime.status = (() => { throw new TypeError("secret-canary-runtime"); }) as never;
  const failedHandler = createWorldRequestHandler({ runtime: failed.runtime, resolveBearer: () => "principal-red" });
  const failedResponse = failedHandler.handle({ operation: "status", bearer: "red-bearer", body: encode({ decision_token: "decision-red" }) });
  assert.equal(failedResponse.status, 500);
  assert.equal(new TextDecoder().decode(failedResponse.body).includes("secret-canary"), false);

  const oversized = recordingRuntime();
  oversized.runtime.status = (() => ({ value: "x".repeat(512) })) as never;
  const bounded = createWorldRequestHandler({ runtime: oversized.runtime, resolveBearer: () => "principal-red", maxResponseBytes: 128 });
  const boundedResponse = bounded.handle({ operation: "status", bearer: "red-bearer", body: encode({ decision_token: "decision-red" }) });
  assert.equal(boundedResponse.status, 500);
  assert.ok(boundedResponse.body.byteLength < 128);

  const resolverFailure = createWorldRequestHandler({ runtime: recordingRuntime().runtime, resolveBearer: () => { throw new Error("secret-canary-resolver"); } });
  const resolverResponse = resolverFailure.handle({ operation: "status", bearer: "red-bearer", body: encode({ decision_token: "decision-red" }) });
  assert.equal(resolverResponse.status, 500);
  assert.equal(new TextDecoder().decode(resolverResponse.body).includes("secret-canary"), false);
});

test("owns non-leaking bearer preflight for transport session admission", () => {
  const fixture = recordingRuntime();
  let calls = 0;
  const handler = createWorldRequestHandler({
    runtime: fixture.runtime,
    resolveBearer: (value) => {
      calls += 1;
      if (value === "secret-canary-throw") throw new Error("secret-canary-resolver");
      return value === "red-bearer" ? "principal-red" : undefined;
    },
  });
  assert.deepEqual(handler.authenticate("red-bearer"), { kind: "authorized" });
  assert.deepEqual(handler.authenticate("unknown-bearer"), { kind: "unauthorized" });
  assert.deepEqual(handler.authenticate("bad bearer"), { kind: "unauthorized" });
  assert.deepEqual(handler.authenticate("secret-canary-throw"), { kind: "internal_error" });
  const encoded = JSON.stringify([
    handler.authenticate("red-bearer"),
    handler.authenticate("unknown-bearer"),
    handler.authenticate("secret-canary-throw"),
  ]);
  assert.equal(encoded.includes("principal-red"), false);
  assert.equal(encoded.includes("secret-canary"), false);
  assert.equal(calls, 6);
  assert.equal(fixture.calls.length, 0);
});
