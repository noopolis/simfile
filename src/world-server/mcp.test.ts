import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { activateWorldDecisionClaim, enableWorldDecisionClaim,
  WORLD_DECISION_CLAIM_CAPABILITY } from "../world/decisionClaim.js";
import { runtimeFixture } from "../world/runtime.test-helper.js";
import type { AuthenticatedWorldContext, WorldRuntime } from "../world/runtime.js";
import { createWorldRequestHandler, type WorldAuthenticatingRequestHandler } from "./handler.js";
import { parseWorldJson } from "./jsonCodec.js";
import { WORLD_MCP_TOOLS } from "./mcpSchemas.js";
import {
  createWorldMcpRequestListener,
  WORLD_MCP_HTTP_LIMITS,
  type WorldMcpRequestListener,
} from "./nodeMcpListener.js";

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

const recordingClaimHandler = (
  fixture: ReturnType<typeof recordingRuntime>,
  acceptsBearer: (value: string) => boolean = () => true,
): WorldAuthenticatingRequestHandler => {
  const encoder = new TextEncoder();
  return {
    operations: ["status", "claim"],
    authenticate: (value) => ({
      kind: typeof value === "string" && acceptsBearer(value) ? "authorized" : "unauthorized",
    }),
    handle: ({ operation, bearer, body }) => {
      if (typeof bearer !== "string" || !acceptsBearer(bearer)) {
        return { status: 401, body: encoder.encode('{"error":{"code":"unauthorized"}}') };
      }
      if (operation === "claim") {
        return { status: 200, body: encoder.encode(JSON.stringify({
          decision_id: "private-decision",
          decision_token: "private-authority",
          issued_at_tick: 0,
          valid_through_tick: 30_000,
        })) };
      }
      try {
        const value = parseWorldJson(body) as Record<string, unknown>;
        if (value.decision_token !== "private-authority") {
          return { status: 403, body: encoder.encode('{"error":{"code":"world_denied"}}') };
        }
        const result = fixture.runtime.status({
          principal: "principal-red",
          decisionToken: "private-authority",
        });
        return { status: 200, body: encoder.encode(JSON.stringify(result)) };
      } catch {
        return { status: 500, body: encoder.encode('{"error":{"code":"internal_error"}}') };
      }
    },
  };
};

const claimSession = async (client: Client, suffix: string): Promise<void> => {
  assert.deepEqual(details(await client.callTool({
    name: "world_claim",
    arguments: { request_id: `request-${suffix}`, wake_id: `wake-${suffix}` },
  })), { claimed: true });
};

const listen = async (listener: WorldMcpRequestListener): Promise<{
  listener: WorldMcpRequestListener;
  server: Server;
  url: URL;
}> => {
  const server = createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test address");
  return { listener, server, url: new URL(`http://127.0.0.1:${address.port}/mcp`) };
};
const close = async (hosted: Awaited<ReturnType<typeof listen>>): Promise<void> => {
  await hosted.listener.close();
  hosted.server.closeAllConnections();
  await new Promise<void>((resolve, reject) => hosted.server.close((error) => error ? reject(error) : resolve()));
};
const connect = async (url: URL, bearer = "red-bearer") => {
  const client = new Client({ name: "simfile-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  await client.connect(transport);
  return { client, transport };
};
const details = (value: Awaited<ReturnType<Client["callTool"]>>): unknown => {
  const content = (value as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const block = content[0] as { type?: unknown; text?: unknown } | undefined;
  assert.equal(block?.type, "text");
  const text = block?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text as string) as unknown;
};

test("publishes six exact token-free schemas and denies calls without private session authority", async () => {
  const fixture = recordingRuntime();
  const hosted = await listen(createWorldMcpRequestListener({ handler: createWorldRequestHandler({
    runtime: fixture.runtime,
    resolveBearer: (value) => value === "red-bearer" ? "principal-red" : undefined,
  }) }));
  try {
    const { client } = await connect(hosted.url);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), WORLD_MCP_TOOLS.map((tool) => tool.name));
    assert.deepEqual(listed.tools.map((tool) => tool.inputSchema), WORLD_MCP_TOOLS.map((tool) => tool.inputSchema));
    assert.equal(JSON.stringify(listed).includes("decision_token"), false);
    const cursor = (listed.tools.at(-1)!.inputSchema.properties!.result_after as { properties: Record<string, unknown> });
    assert.deepEqual(Object.keys(cursor.properties), [
      "version", "issuer", "principal", "run_id", "world_id", "world_instance_id", "manifest_digest", "after", "proof",
    ]);
    const denied = await client.callTool({ name: "world_status", arguments: {} });
    assert.equal(denied.isError, true);
    assert.deepEqual(details(denied), { error: { code: "world_denied" } });
    const planted = await client.callTool({ name: "world_status", arguments: { decision_token: "planted" } });
    assert.equal(planted.isError, true);
    assert.equal(JSON.stringify(planted).includes("planted"), false);
    assert.deepEqual(fixture.calls, []);
    await client.close();
  } finally { await close(hosted); }
});

test("advertised claim extension has JSON-parity schema and stays bearer-bound over MCP", async () => {
  const fixture = runtimeFixture();
  fixture.decisionRegistry.consumeForAct({ principal: "principal-red", runId: "run-1",
    worldInstanceId: "instance-1", token: fixture.red.token, atTick: 0 });
  enableWorldDecisionClaim(fixture.runtime);
  activateWorldDecisionClaim(fixture.runtime);
  const hosted = await listen(createWorldMcpRequestListener({ handler: createWorldRequestHandler({
    runtime: fixture.runtime,
    capabilities: [WORLD_DECISION_CLAIM_CAPABILITY],
    resolveBearer: (value) => value === "red-bearer" ? "principal-red" : undefined,
  }) }));
  try {
    const { client } = await connect(hosted.url);
    const listed = await client.listTools();
    assert.equal(listed.tools[0]?.name, "world_claim");
    assert.deepEqual(listed.tools[0]?.inputSchema.required, ["request_id", "wake_id"]);
    const request = { request_id: "mcp-claim-red-1", wake_id: "mcp-schedule-red-1" };
    const claimCall = await client.callTool({ name: "world_claim", arguments: request });
    const claimed = details(claimCall);
    assert.deepEqual(claimed, { claimed: true });
    assert.equal(JSON.stringify(claimCall).includes("decision_token"), false);
    const status = details(await client.callTool({ name: "world_status", arguments: {} })) as {
      decision: { id: string };
    };
    assert.equal(typeof status.decision.id, "string");
    const replay = await client.callTool({ name: "world_claim", arguments: request });
    assert.equal(replay.isError, true);
    assert.equal(JSON.stringify(replay).includes("decision_token"), false);
    await client.close();
  } finally { await close(hosted); }
});

test("binds sessions to one bearer, rejects failed auth, and deletes terminated sessions", async () => {
  const fixture = recordingRuntime();
  const hosted = await listen(createWorldMcpRequestListener({ handler: createWorldRequestHandler({
    runtime: fixture.runtime,
    resolveBearer: (value) => value === "red-bearer" ? "principal-red" : value === "blue-bearer" ? "principal-blue" : undefined,
  }) }));
  try {
    await assert.rejects(connect(hosted.url, "secret-canary-invalid"));
    const { client, transport } = await connect(hosted.url);
    const sessionId = transport.sessionId;
    assert.ok(sessionId);
    const swapped = await fetch(hosted.url, {
      method: "POST",
      headers: {
        authorization: "Bearer blue-bearer",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }),
    });
    assert.equal(swapped.status, 401);
    assert.equal((await swapped.text()).includes("blue-bearer"), false);
    await transport.terminateSession();
    const stale = await fetch(hosted.url, {
      method: "POST",
      headers: {
        authorization: "Bearer red-bearer",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list", params: {} }),
    });
    assert.equal(stale.status, 404);
    assert.equal(fixture.calls.length, 0);
    await client.close();
  } finally { await close(hosted); }
});

test("bogus bearers cannot exhaust capacity and concurrent initialization admits only one session", async () => {
  const fixture = recordingRuntime();
  const hosted = await listen(createWorldMcpRequestListener({
    handler: createWorldRequestHandler({
      runtime: fixture.runtime,
      resolveBearer: (value) => value === "red-bearer" ? "principal-red" : undefined,
    }),
    maxSessions: 1,
  }));
  try {
    const bogus = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => connect(hosted.url, `bogus-${index}`)));
    assert.ok(bogus.every((result) => result.status === "rejected"));
    const raced = await Promise.allSettled([connect(hosted.url), connect(hosted.url)]);
    assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(raced.filter((result) => result.status === "rejected").length, 1);
    const admitted = raced.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof connect>>> => result.status === "fulfilled")!.value;
    const oldSession = admitted.transport.sessionId;
    assert.ok(oldSession);
    await admitted.transport.terminateSession();
    await assert.rejects(admitted.client.callTool({ name: "world_status", arguments: {} }));
    await admitted.client.close();
    const replacement = await connect(hosted.url);
    assert.ok(replacement.transport.sessionId);
    assert.notEqual(replacement.transport.sessionId, oldSession);
    await replacement.transport.terminateSession();
    await replacement.client.close();
    assert.equal(fixture.calls.length, 0);
  } finally { await close(hosted); }
});

test("DELETE rejects and drains request bodies without closing the live session", async () => {
  const fixture = recordingRuntime();
  const hosted = await listen(createWorldMcpRequestListener({ handler: createWorldRequestHandler({
    runtime: fixture.runtime,
    resolveBearer: () => "principal-red",
  }) }));
  try {
    const { client, transport } = await connect(hosted.url);
    const sessionId = transport.sessionId;
    assert.ok(sessionId);
    const rejected = await fetch(hosted.url, {
      method: "DELETE",
      headers: {
        authorization: "Bearer red-bearer",
        "mcp-protocol-version": "2025-06-18",
        "mcp-session-id": sessionId,
      },
      body: "secret-canary-delete-body",
    });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.text()).includes("secret-canary"), false);
    const denied = await client.callTool({ name: "world_status", arguments: {} });
    assert.equal(denied.isError, true);
    await transport.terminateSession();
    await client.close();
    assert.equal(fixture.calls.length, 0);
  } finally { await close(hosted); }
});

test("bounds bodies and nesting and suppresses dispatch on disconnect", async () => {
  const fixture = recordingRuntime();
  const hosted = await listen(createWorldMcpRequestListener({ handler: createWorldRequestHandler({
    runtime: fixture.runtime,
    resolveBearer: () => "principal-red",
  }), deadlineMs: 30 }));
  try {
    const oversized = await fetch(hosted.url, {
      method: "POST",
      headers: { authorization: "Bearer red-bearer", "content-type": "application/json" },
      body: "x".repeat(WORLD_MCP_HTTP_LIMITS.body_bytes + 1),
    });
    assert.equal(oversized.status, 413);
    const nested = `${"[".repeat(34)}0${"]".repeat(34)}`;
    const deep = await fetch(hosted.url, {
      method: "POST",
      headers: { authorization: "Bearer red-bearer", "content-type": "application/json" },
      body: nested,
    });
    assert.equal(deep.status, 400);
    const wide = await fetch(hosted.url, {
      method: "POST",
      headers: { authorization: "Bearer red-bearer", "content-type": "application/json", "x-wide": "x".repeat(9_000) },
      body: "{}",
    });
    assert.equal(wide.status, 431);
    const slowStatus = await new Promise<number>((resolve, reject) => {
      const slow = httpRequest(hosted.url, {
        method: "POST",
        headers: {
          authorization: "Bearer red-bearer",
          "content-type": "application/json",
          "content-length": "200",
        },
      }, (response) => {
        response.resume();
        response.once("end", () => { resolve(response.statusCode ?? 0); slow.destroy(); });
      });
      slow.once("error", reject);
      slow.flushHeaders();
    });
    assert.equal(slowStatus, 408);
    await new Promise<void>((resolve) => {
      const request = httpRequest(hosted.url, {
        method: "POST",
        headers: {
          authorization: "Bearer red-bearer",
          "content-type": "application/json",
          "content-length": "200",
        },
      });
      request.on("error", () => resolve());
      request.write('{"jsonrpc":"2.0","id":1');
      request.destroy();
      setImmediate(resolve);
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fixture.calls.length, 0);
  } finally { await close(hosted); }
});
