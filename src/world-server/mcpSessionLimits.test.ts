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


test("returns fixed redacted tool errors and bounds MCP wire responses", async () => {
  const fixture = recordingRuntime();
  fixture.runtime.status = (() => { throw new Error("secret-canary-runtime"); }) as never;
  const hosted = await listen(createWorldMcpRequestListener({
    handler: recordingClaimHandler(fixture, (value) => value === "secret-canary-bearer"),
  }));
  try {
    const { client } = await connect(hosted.url, "secret-canary-bearer");
    await claimSession(client, "redacted");
    const failed = await client.callTool({ name: "world_status", arguments: {} });
    const serialized = JSON.stringify(failed);
    assert.equal(failed.isError, true);
    assert.equal(serialized.includes("secret-canary"), false);
    assert.deepEqual(details(failed), { error: { code: "internal_error" } });
    await client.close();
  } finally { await close(hosted); }
});

test("an existing-session deadline abort closes the session and releases capacity", async () => {
  const fixture = recordingRuntime();
  const hosted = await listen(createWorldMcpRequestListener({
    handler: recordingClaimHandler(fixture),
    deadlineMs: 100,
    maxSessions: 1,
  }));
  try {
    const { client, transport } = await connect(hosted.url);
    const oldSession = transport.sessionId;
    assert.ok(oldSession);
    await claimSession(client, "deadline");
    fixture.runtime.status = ((context: AuthenticatedWorldContext) => {
      const until = performance.now() + 150;
      while (performance.now() < until) { /* Deliberately block the focused fake boundary. */ }
      return { context };
    }) as never;
    await assert.rejects(client.callTool({ name: "world_status", arguments: {} }));
    const stale = await fetch(hosted.url, {
      method: "POST",
      headers: {
        authorization: "Bearer red-bearer",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        "mcp-session-id": oldSession,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }),
    });
    assert.equal(stale.status, 404);
    fixture.runtime.status = ((context: AuthenticatedWorldContext) => ({ context })) as never;
    const replacement = await connect(hosted.url);
    await replacement.transport.terminateSession();
    await replacement.client.close();
    await client.close();
  } finally { await close(hosted); }
});

test("an oversized existing-session response closes the session and releases capacity", async () => {
  const fixture = recordingRuntime();
  fixture.runtime.status = (() => ({ value: "x".repeat(8_192) })) as never;
  const hosted = await listen(createWorldMcpRequestListener({
    handler: recordingClaimHandler(fixture),
    maxResponseBytes: 1_024,
    maxSessions: 1,
  }));
  try {
    const { client, transport } = await connect(hosted.url);
    const oldSession = transport.sessionId;
    assert.ok(oldSession);
    await claimSession(client, "oversized");
    await assert.rejects(client.callTool({ name: "world_status", arguments: {} }));
    const replacement = await connect(hosted.url);
    assert.notEqual(replacement.transport.sessionId, oldSession);
    await replacement.transport.terminateSession();
    await replacement.client.close();
    await client.close();
  } finally { await close(hosted); }
});
