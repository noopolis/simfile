import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { activateWorldDecisionClaim, enableWorldDecisionClaim,
  WORLD_DECISION_CLAIM_CAPABILITY } from "../world/decisionClaim.js";
import { registerWorldBoundaryObserver } from "../world/boundaryObserver.js";
import { runtimeFixture } from "../world/runtime.test-helper.js";
import { createWorldRequestHandler } from "./handler.js";
import { createWorldJsonServer } from "./jsonServer.js";
import { createWorldJsonRequestListener } from "./nodeJsonListener.js";
import { worldMcpTools } from "./mcpSchemas.js";

const post = (origin: string, operation: string, bearer: string, body: unknown) =>
  fetch(`${origin}/v1/world/${operation}`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("real JSON server runs the bearer-authenticated claim lifecycle without a delivery token", async () => {
  const fixture = runtimeFixture();
  fixture.decisionRegistry.consumeForAct({ principal: "principal-red", runId: "run-1",
    worldInstanceId: "instance-1", token: fixture.red.token, atTick: 0 });
  enableWorldDecisionClaim(fixture.runtime);
  const observed: string[] = [];
  registerWorldBoundaryObserver(fixture.runtime, {
    begin: ({ operation, request }) => {
      observed.push(`${operation}:${new TextDecoder().decode(request)}`);
      return { complete: ({ status, response }) => {
        observed.push(`${status}:${new TextDecoder().decode(response)}`);
      } };
    },
  });
  const handler = createWorldRequestHandler({
    runtime: fixture.runtime,
    capabilities: [WORLD_DECISION_CLAIM_CAPABILITY],
    resolveBearer: (bearer) => ({ "red-bearer": "principal-red",
      "blue-bearer": "principal-blue" })[bearer],
  });
  assert.deepEqual(worldMcpTools(handler.operations).map((tool) => tool.name), [
    "world_claim", "world_status", "world_capabilities", "world_observe",
    "world_affordances", "world_act", "world_ledger",
  ]);
  const server = createServer(createWorldJsonRequestListener({
    server: createWorldJsonServer({ handler }),
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const claimBody = { request_id: "claim-http-red-1", wake_id: "schedule-http-red-1" };
    assert.equal((await post(origin, "claim", "red-bearer", claimBody)).status, 403);
    activateWorldDecisionClaim(fixture.runtime);
    const claimedResponse = await post(origin, "claim", "red-bearer", claimBody);
    assert.equal(claimedResponse.status, 200);
    const claimed = await claimedResponse.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(claimed).sort(), [
      "decision_id", "decision_token", "issued_at_tick", "valid_through_tick",
    ]);
    assert.equal(typeof claimed.decision_token, "string");
    assert.equal((await post(origin, "status", "red-bearer", {
      decision_token: claimed.decision_token,
    })).status, 200);
    assert.equal((await post(origin, "claim", "red-bearer", claimBody)).status, 403);
    assert.equal((await post(origin, "claim", "blue-bearer", {
      request_id: "claim-http-blue-1", wake_id: "schedule-http-red-1",
    })).status, 403);
    assert.equal((await post(origin, "claim", "wrong-bearer", {
      request_id: "claim-http-wrong-1", wake_id: "schedule-http-wrong-1",
    })).status, 401);
    assert.equal(observed.join("\n").includes(String(claimed.decision_token)), false);
    assert.equal(observed.includes('200:{"claimed":true}'), true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const base = createWorldRequestHandler({ runtime: fixture.runtime,
    resolveBearer: () => "principal-red" });
  assert.equal(base.handle({ operation: "claim", bearer: "red-bearer",
    body: new TextEncoder().encode('{"request_id":"base-1","wake_id":"base-1"}') }).status, 404);
  assert.equal(worldMcpTools(base.operations).some((tool) => tool.name === "world_claim"), false);
});
