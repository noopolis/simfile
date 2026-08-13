import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { WorldRuntime } from "../world/runtime.js";
import { createWorldRequestHandler } from "./handler.js";
import { createMcpSessionLifecycle } from "./mcpSessionLifecycle.js";
import {
  createWorldMcpRequestListener,
  type WorldMcpRequestListener,
} from "./nodeMcpListener.js";

const runtime = {
  status: () => ({ operation: "status" }),
  capabilities: () => ({ operation: "capabilities" }),
  observe: () => ({ operation: "observe" }),
  affordances: () => ({ operation: "affordances" }),
  act: () => ({ operation: "act" }),
  ledger: () => ({ operation: "ledger" }),
} as unknown as WorldRuntime;

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
const handler = (resolveBearer: (bearer: string) => string | undefined) => createWorldRequestHandler({ runtime, resolveBearer });

const host = async (listener: WorldMcpRequestListener): Promise<{
  readonly listener: WorldMcpRequestListener;
  readonly server: Server;
  readonly url: URL;
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

const shutdown = async (hosted: Awaited<ReturnType<typeof host>>): Promise<void> => {
  await hosted.listener.close();
  hosted.server.closeAllConnections();
  await new Promise<void>((resolve, reject) => hosted.server.close((cause) => cause ? reject(cause) : resolve()));
};

const connect = async (url: URL, bearer = "red-bearer") => {
  const client = new Client({ name: "simfile-lifecycle-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  try {
    await client.connect(transport);
    return { client, transport };
  } catch (cause) {
    await client.close().catch(() => undefined);
    throw cause;
  }
};

const eventuallyConnect = async (url: URL, bearer = "red-bearer") => {
  const deadline = performance.now() + 1_500;
  while (true) {
    try { return await connect(url, bearer); }
    catch (cause) {
      if (performance.now() >= deadline) throw cause;
      await wait(20);
    }
  }
};

const rpc = (url: URL, bearer: string, sessionId: string, body: unknown, version = "2025-06-18") => fetch(url, {
  method: "POST",
  headers: {
    authorization: `Bearer ${bearer}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": version,
    "mcp-session-id": sessionId,
  },
  body: JSON.stringify(body),
});

const initialize = (url: URL, bearer = "red-bearer") => fetch(url, {
  method: "POST",
  headers: {
    authorization: `Bearer ${bearer}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw-test", version: "1" } },
  }),
});

test("lifecycle releases capacity when hostile close hangs and ignores detached or double disposal", async () => {
  let closes = 0;
  const lifecycle = createMcpSessionLifecycle({ maxSessions: 1, idleTtlMs: 1_000, closeTimeoutMs: 20 });
  const first = lifecycle.reserve();
  assert.ok(first);
  const lease = first.commit("one", "red-bearer", {
    close: () => { closes += 1; return new Promise<void>(() => {}); },
  });
  assert.ok(lease);
  lease.release();
  assert.equal(lifecycle.reserve(), undefined);
  const disposal = lifecycle.dispose(lease.session);
  const replacement = lifecycle.reserve();
  assert.ok(replacement);
  const second = replacement.commit("two", "red-bearer", { close: async () => { closes += 1; } });
  assert.ok(second);
  second.release();
  await lifecycle.dispose({ ...lease.session, value: { close: async () => { closes += 100; } } });
  await lifecycle.dispose(lease.session);
  await disposal;
  assert.equal(closes, 1);
  await lifecycle.close();
  assert.equal(closes, 2);
});

test("idle TTL reclaims max-one capacity for an abandoned successful initialization", async () => {
  const hosted = await host(createWorldMcpRequestListener({
    handler: handler((bearer) => bearer === "red-bearer" ? "principal-red" : undefined),
    maxSessions: 1,
    idleSessionMs: 100,
  }));
  try {
    const initialized = await initialize(hosted.url);
    assert.equal(initialized.status, 200);
    const abandonedId = initialized.headers.get("mcp-session-id");
    assert.ok(abandonedId);
    await assert.rejects(connect(hosted.url));
    const replacement = await eventuallyConnect(hosted.url);
    assert.notEqual(replacement.transport.sessionId, abandonedId);
    await replacement.transport.terminateSession();
    await replacement.client.close();
  } finally { await shutdown(hosted); }
});

test("ordinary client close without DELETE is bounded by idle expiry and frees capacity", async () => {
  const hosted = await host(createWorldMcpRequestListener({
    handler: handler(() => "principal-red"),
    maxSessions: 1,
    idleSessionMs: 100,
  }));
  try {
    const first = await connect(hosted.url);
    const abandonedId = first.transport.sessionId;
    assert.ok(abandonedId);
    await first.client.close();
    await assert.rejects(connect(hosted.url));
    const replacement = await eventuallyConnect(hosted.url);
    assert.notEqual(replacement.transport.sessionId, abandonedId);
    await replacement.transport.terminateSession();
    await replacement.client.close();
  } finally { await shutdown(hosted); }
});

test("same-bearer revoked and throwing preflights dispose their exact sessions", async () => {
  let mode: "allowed" | "revoked" | "throw" = "allowed";
  const hosted = await host(createWorldMcpRequestListener({
    handler: handler((bearer) => {
      if (mode === "throw") throw new Error("secret-canary-resolver");
      return mode === "allowed" && bearer === "red-bearer" ? "principal-red" : undefined;
    }),
    maxSessions: 1,
  }));
  try {
    const revoked = await connect(hosted.url);
    const revokedId = revoked.transport.sessionId;
    assert.ok(revokedId);
    mode = "revoked";
    const rejected = await rpc(hosted.url, "red-bearer", revokedId, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assert.equal(rejected.status, 401);
    assert.equal(await rejected.text(), '{"error":{"code":"unauthorized"}}');
    mode = "allowed";
    const throwing = await connect(hosted.url);
    const throwingId = throwing.transport.sessionId;
    assert.ok(throwingId);
    mode = "throw";
    const failed = await rpc(hosted.url, "red-bearer", throwingId, { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    assert.equal(failed.status, 500);
    assert.equal((await failed.text()).includes("secret-canary"), false);
    mode = "allowed";
    const recovered = await connect(hosted.url);
    await recovered.transport.terminateSession();
    await Promise.allSettled([revoked.client.close(), throwing.client.close(), recovered.client.close()]);
  } finally { await shutdown(hosted); }
});

test("a switched valid bearer cannot touch or evict another bearer's session", async () => {
  const hosted = await host(createWorldMcpRequestListener({
    handler: handler((bearer) => bearer === "red-bearer" ? "principal-red" : bearer === "blue-bearer" ? "principal-blue" : undefined),
    maxSessions: 1,
  }));
  try {
    const red = await connect(hosted.url);
    const redId = red.transport.sessionId;
    assert.ok(redId);
    const switched = await rpc(hosted.url, "blue-bearer", redId, { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
    assert.equal(switched.status, 401);
    await red.client.listTools();
    await assert.rejects(connect(hosted.url, "blue-bearer"));
    await red.transport.terminateSession();
    await red.client.close();
    const blue = await connect(hosted.url, "blue-bearer");
    await blue.transport.terminateSession();
    await blue.client.close();
  } finally { await shutdown(hosted); }
});

test("listener close aborts pending work, disposes sessions, and settles idempotently", async () => {
  const listener = createWorldMcpRequestListener({ handler: handler(() => "principal-red"), maxSessions: 1, deadlineMs: 250 });
  const hosted = await host(listener);
  const connected = await connect(hosted.url);
  const sessionId = connected.transport.sessionId;
  assert.ok(sessionId);
  const pending = new Promise<void>((resolve) => {
    const request = httpRequest(hosted.url, {
      method: "POST",
      headers: {
        authorization: "Bearer red-bearer",
        "content-type": "application/json",
        "content-length": "200",
        "mcp-session-id": sessionId,
      },
    });
    request.on("error", () => resolve());
    request.on("response", (response) => { response.resume(); response.on("end", resolve); });
    request.write('{"jsonrpc":"2.0","id":5');
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const started = performance.now();
  await Promise.all([listener.close(), listener.close()]);
  assert.ok(performance.now() - started < 500);
  await Promise.race([pending, wait(500).then(() => { throw new Error("pending request was not aborted"); })]);
  const closed = await initialize(hosted.url);
  assert.equal(closed.status, 503);
  assert.equal(await closed.text(), '{"error":{"code":"listener_closed"}}');
  await connected.client.close();
  await shutdown(hosted);
});

test("sanitizes SDK protocol and malformed-request diagnostics without closing a valid session", async () => {
  const hosted = await host(createWorldMcpRequestListener({ handler: handler(() => "principal-red") }));
  try {
    const connected = await connect(hosted.url);
    const sessionId = connected.transport.sessionId;
    assert.ok(sessionId);
    const unsupported = await rpc(
      hosted.url,
      "red-bearer",
      sessionId,
      { jsonrpc: "2.0", id: 6, method: "tools/list", params: {} },
      "secret-canary-version",
    );
    assert.equal(unsupported.status, 400);
    assert.equal(await unsupported.text(), '{"error":{"code":"invalid_request"}}');
    assert.equal(JSON.stringify([...unsupported.headers]).includes("secret-canary"), false);
    const malformed = await rpc(hosted.url, "red-bearer", sessionId, {
      jsonrpc: "2.0", id: 7, method: 7, secret: "secret-canary-malformed",
    });
    assert.equal(malformed.status, 400);
    assert.equal(await malformed.text(), '{"error":{"code":"invalid_request"}}');
    await connected.client.listTools();
    await connected.transport.terminateSession();
    await connected.client.close();
  } finally { await shutdown(hosted); }
});

test("sanitizes a throwing session-id generator and releases its pending capacity", async () => {
  let fail = true;
  const hosted = await host(createWorldMcpRequestListener({
    handler: handler(() => "principal-red"),
    maxSessions: 1,
    sessionIdGenerator: () => {
      if (fail) throw new Error("secret-canary-generator");
      return "safe-session-id";
    },
  }));
  try {
    const rejected = await initialize(hosted.url);
    assert.equal(rejected.status, 400);
    assert.equal(await rejected.text(), '{"error":{"code":"invalid_request"}}');
    assert.equal(JSON.stringify([...rejected.headers]).includes("secret-canary"), false);
    fail = false;
    const replacement = await connect(hosted.url);
    assert.equal(replacement.transport.sessionId, "safe-session-id");
    await replacement.transport.terminateSession();
    await replacement.client.close();
  } finally { await shutdown(hosted); }
});
