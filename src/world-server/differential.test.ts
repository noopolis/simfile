import assert from "node:assert/strict";
import test from "node:test";

import { encodeWorldActEnvelope } from "../world/actEnvelope.js";
import { WORLD_ACTION_RESULT_PAGE_REQUEST_VERSION } from "../world/actionResultLedger.js";
import { runtimeFixture } from "../world/runtime.test-helper.js";
import { createWorldRequestHandler } from "./handler.js";
import { createWorldJsonServer } from "./jsonServer.js";
import { parseWorldJson } from "./jsonCodec.js";

const UTF8 = new TextEncoder();
const body = async function* (value: unknown): AsyncGenerator<Uint8Array> { yield UTF8.encode(JSON.stringify(value)); };
const normalized = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

test("JSON routes match direct WorldRuntime semantics through idempotent act and result-ledger read", async () => {
  const direct = runtimeFixture();
  const routed = runtimeFixture();
  const directContext = { principal: "principal-red", decisionToken: direct.red.token };
  const handler = createWorldRequestHandler({
    runtime: routed.runtime,
    resolveBearer: (bearer) => bearer === "red-bearer" ? "principal-red" : undefined,
  });
  const server = createWorldJsonServer({ handler });
  const route = async (operation: string, value: unknown): Promise<unknown> => {
    const response = await server.handle({
      method: "POST",
      path: `/v1/world/${operation}`,
      headers: [["authorization", "Bearer red-bearer"], ["content-type", "application/json"]],
      body: body(value),
    });
    assert.equal(response?.status, 200);
    return parseWorldJson(response!.body);
  };

  assert.deepEqual(await route("status", { decision_token: routed.red.token }), normalized(direct.runtime.status(directContext)));
  assert.deepEqual(await route("capabilities", { decision_token: routed.red.token }), normalized(direct.runtime.capabilities(directContext)));
  const sense = "world://pitch/sense/vision";
  assert.deepEqual(await route("observe", { decision_token: routed.red.token, sense }), normalized(direct.runtime.observe(directContext, { sense })));
  assert.deepEqual(await route("affordances", { decision_token: routed.red.token }), normalized(direct.runtime.affordances(directContext)));

  const action = {
    request_id: "differential-request-1",
    affordance: "world://pitch/affordance/kick",
    target: "world://pitch/entity/ball",
    input: { force: 1 },
  };
  const directFirst = direct.runtime.act(directContext, encodeWorldActEnvelope(action));
  const directRetry = direct.runtime.act(directContext, encodeWorldActEnvelope(action));
  assert.equal(directFirst.disposition, "queued");
  const routedBody = { decision_token: routed.red.token, ...action };
  const routedFirst = await route("act", routedBody);
  const routedRetry = await route("act", routedBody);
  assert.deepEqual(routedFirst, normalized(directFirst));
  assert.deepEqual(routedRetry, normalized(directRetry));
  assert.deepEqual(routedRetry, routedFirst);

  const ledgerRequest = { version: WORLD_ACTION_RESULT_PAGE_REQUEST_VERSION, limit: 10 } as const;
  const directResults = direct.runtime.ledger(directContext, ledgerRequest);
  const routedResults = await route("ledger", { decision_token: routed.red.token, ...ledgerRequest });
  assert.deepEqual(routedResults, normalized(directResults));
  assert.deepEqual((routedResults as { results: unknown[] }).results, []);
  assert.equal(direct.dynamicsCalls(), routed.dynamicsCalls());
});

test("real-runtime readiness does not resolve identity, consume a decision, or read mechanics", async () => {
  const fixture = runtimeFixture();
  let resolutions = 0;
  const before = fixture.decisionRegistry.snapshot();
  const handler = createWorldRequestHandler({
    runtime: fixture.runtime,
    resolveBearer: () => { resolutions += 1; return "principal-red"; },
  });
  const response = await createWorldJsonServer({ handler }).handle({ method: "GET", path: "/readyz", headers: [] });
  assert.equal(response?.status, 200);
  assert.equal(resolutions, 0);
  assert.equal(fixture.dynamicsCalls(), 0);
  assert.deepEqual(fixture.decisionRegistry.snapshot(), before);
  assert.deepEqual(fixture.readLedger.read("principal-red", {}).records, []);
});
