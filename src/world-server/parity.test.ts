import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  readWorldActionResultLedger,
  WORLD_ACTION_RESULT_PAGE_REQUEST_VERSION,
} from "../world/actionResultLedger.js";
import type { CapabilityManifestArtifact } from "../world/capabilityManifest.js";
import { activateWorldDecisionClaim, enableWorldDecisionClaim,
  WORLD_DECISION_CLAIM_CAPABILITY } from "../world/decisionClaim.js";
import { runtimeActionResultLedger, runtimeFixture } from "../world/runtime.test-helper.js";
import type { AuthenticatedWorldContext, WorldRuntime } from "../world/runtime.js";
import { createWorldRequestHandler } from "./handler.js";
import { parseWorldJson } from "./jsonCodec.js";
import { createWorldJsonServer } from "./jsonServer.js";
import { createWorldMcpRequestListener, type WorldMcpRequestListener } from "./nodeMcpListener.js";

const UTF8 = new TextEncoder();
const normalized = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;
const body = async function* (value: unknown): AsyncGenerator<Uint8Array> { yield UTF8.encode(JSON.stringify(value)); };
const close = async (server: Server, listener: WorldMcpRequestListener): Promise<void> => {
  await listener.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
};
const mcpDetails = (value: Awaited<ReturnType<Client["callTool"]>>): unknown => {
  const content = (value as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const block = content[0] as { type?: unknown; text?: unknown } | undefined;
  assert.equal(block?.type, "text");
  const text = block?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text as string) as unknown;
};

const seedResult = (fixture: {
  readonly runtime: WorldRuntime;
  readonly capabilityManifests: readonly CapabilityManifestArtifact[];
}): void => {
  const manifest = fixture.capabilityManifests.find(({ manifest: value }) => value.holder.principal === "principal-red")!.manifest;
  const ledger = runtimeActionResultLedger(fixture.runtime);
  assert.ok(ledger);
  const authority = readWorldActionResultLedger(ledger);
  assert.ok(authority);
  authority.append({
    principal: "principal-red",
    result: Object.freeze({
      version: "simfile.world-action-result.v1" as const,
      result_id: "world-result-1",
      receipt_id: "world-act-1",
      decision_id: "decision-000000000001",
      actor: manifest.holder.entity,
      action_sequence: 1,
      apply_tick: 0,
      status: "applied" as const,
      caused_effect_ids: Object.freeze(["world-effect-1"]),
      identity: Object.freeze({
        run_id: manifest.run_id,
        world_id: manifest.world.id,
        world_instance_id: manifest.world.instance_id,
        manifest_digest: manifest.manifest_digest,
        state_version: 2,
      }),
    }),
  });
};

const cursorSemantics = (value: unknown): unknown => {
  assert.ok(value !== null && typeof value === "object");
  const { issuer: _issuer, proof: _proof, ...semantic } = value as Record<string, unknown>;
  return semantic;
};

test("authenticated JSON and MCP vectors yield identical real-runtime semantics and stable duplicate receipts", async () => {
  const jsonFixture = runtimeFixture();
  const mcpFixture = runtimeFixture();
  jsonFixture.decisionRegistry.consumeForAct({
    principal: "principal-red",
    runId: "run-1",
    worldInstanceId: "instance-1",
    token: jsonFixture.red.token,
    atTick: 0,
  });
  enableWorldDecisionClaim(jsonFixture.runtime);
  activateWorldDecisionClaim(jsonFixture.runtime);
  mcpFixture.decisionRegistry.consumeForAct({
    principal: "principal-red",
    runId: "run-1",
    worldInstanceId: "instance-1",
    token: mcpFixture.red.token,
    atTick: 0,
  });
  enableWorldDecisionClaim(mcpFixture.runtime);
  activateWorldDecisionClaim(mcpFixture.runtime);
  seedResult(jsonFixture);
  seedResult(mcpFixture);
  const mcpRuntime = mcpFixture.runtime;
  const json = createWorldJsonServer({ handler: createWorldRequestHandler({
    runtime: jsonFixture.runtime,
    capabilities: [WORLD_DECISION_CLAIM_CAPABILITY],
    resolveBearer: (value) => value === "red-bearer" ? "principal-red" : undefined,
  }) });
  const listener = createWorldMcpRequestListener({ handler: createWorldRequestHandler({
    runtime: mcpRuntime,
    capabilities: [WORLD_DECISION_CLAIM_CAPABILITY],
    resolveBearer: (value) => value === "red-bearer" ? "principal-red" : undefined,
  }) });
  const node = createServer(listener);
  await new Promise<void>((resolve, reject) => {
    node.once("error", reject);
    node.listen(0, "127.0.0.1", () => { node.off("error", reject); resolve(); });
  });
  const address = node.address();
  if (address === null || typeof address === "string") throw new Error("missing test address");
  const client = new Client({ name: "simfile-parity", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
    requestInit: { headers: { authorization: "Bearer red-bearer" } },
  });
  try {
    await client.connect(transport);
    const jsonCall = async (operation: string, value: unknown): Promise<unknown> => {
      const response = await json.handle({
        method: "POST",
        path: `/v1/world/${operation}`,
        headers: [["authorization", "Bearer red-bearer"], ["content-type", "application/json"]],
        body: body(value),
      });
      assert.equal(response?.status, 200);
      return parseWorldJson(response!.body);
    };
    const mcpCall = async (name: string, value: Record<string, unknown>): Promise<unknown> =>
      mcpDetails(await client.callTool({ name, arguments: value }));

    const jsonClaim = await jsonCall("claim", {
      request_id: "parity-claim-red-1",
      wake_id: "parity-schedule-red-1",
    }) as { decision_token: string };
    assert.equal(typeof jsonClaim.decision_token, "string");
    assert.deepEqual(await mcpCall("world_claim", {
      request_id: "parity-claim-red-1",
      wake_id: "parity-schedule-red-1",
    }), { claimed: true });
    const jsonAuthority = jsonClaim.decision_token;

    const pairs = [
      ["status", "world_status", { decision_token: jsonAuthority }, {}],
      ["capabilities", "world_capabilities", { decision_token: jsonAuthority }, {}],
      ["observe", "world_observe", { decision_token: jsonAuthority, sense: "world://pitch/sense/vision" }, { sense: "world://pitch/sense/vision" }],
      ["affordances", "world_affordances", { decision_token: jsonAuthority }, {}],
    ] as const;
    for (const [operation, name, jsonInput, mcpInput] of pairs) {
      assert.deepEqual(await mcpCall(name, mcpInput), normalized(await jsonCall(operation, jsonInput)));
    }
    const action = {
      request_id: "parity-request-1",
      affordance: "world://pitch/affordance/kick",
      target: "world://pitch/entity/ball",
      input: { force: 1 },
    };
    const jsonAction = { decision_token: jsonAuthority, ...action };
    const mcpAction = action;
    const jsonFirst = await jsonCall("act", jsonAction);
    const mcpFirst = await mcpCall("world_act", mcpAction);
    assert.deepEqual(mcpFirst, normalized(jsonFirst));
    assert.deepEqual(await mcpCall("world_act", mcpAction), mcpFirst);
    assert.deepEqual(await jsonCall("act", jsonAction), jsonFirst);

    const listed = await client.listTools();
    const ledgerTool = listed.tools.find((tool) => tool.name === "world_ledger");
    assert.ok(ledgerTool);
    assert.equal(Object.hasOwn(ledgerTool.inputSchema.properties ?? {}, "version"), false);
    const jsonLedger = await jsonCall("ledger", {
      decision_token: jsonAuthority,
      version: WORLD_ACTION_RESULT_PAGE_REQUEST_VERSION,
      limit: 1,
    });
    const firstMcpArguments = { limit: 1 };
    assert.equal(Object.hasOwn(firstMcpArguments, "version"), false);
    const mcpLedger = await mcpCall("world_ledger", firstMcpArguments) as {
      readonly results: readonly unknown[];
      readonly next_result_after?: unknown;
    };
    const firstJsonPage = jsonLedger as { readonly results: readonly unknown[]; readonly next_result_after?: unknown };
    assert.equal(firstJsonPage.results.length, 1);
    assert.equal(mcpLedger.results.length, 1);
    assert.deepEqual(mcpLedger.results, normalized(firstJsonPage.results));
    assert.ok(firstJsonPage.next_result_after);
    assert.ok(mcpLedger.next_result_after);
    assert.deepEqual(cursorSemantics(mcpLedger.next_result_after), cursorSemantics(firstJsonPage.next_result_after));
    const secondJsonPage = await jsonCall("ledger", {
      decision_token: jsonAuthority,
      version: WORLD_ACTION_RESULT_PAGE_REQUEST_VERSION,
      limit: 1,
      result_after: firstJsonPage.next_result_after,
    }) as { readonly results: readonly unknown[]; readonly next_result_after?: unknown };
    const secondMcpArguments = {
      limit: 1,
      result_after: mcpLedger.next_result_after,
    };
    assert.equal(Object.hasOwn(secondMcpArguments, "version"), false);
    const secondMcpPage = await mcpCall("world_ledger", secondMcpArguments) as {
      readonly results: readonly unknown[];
      readonly next_result_after?: unknown;
    };
    assert.deepEqual(secondMcpPage.results, normalized(secondJsonPage.results));
    assert.deepEqual(secondJsonPage.results, []);
    assert.deepEqual(secondJsonPage.next_result_after, firstJsonPage.next_result_after);
    assert.deepEqual(secondMcpPage.next_result_after, mcpLedger.next_result_after);
    assert.equal(jsonFixture.dynamicsCalls(), mcpFixture.dynamicsCalls());
    await client.close();
  } finally { await close(node, listener); }
});
