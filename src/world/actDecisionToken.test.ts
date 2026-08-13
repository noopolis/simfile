import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import { readWorldRuntimeClockAuthority } from "./clockAuthority.js";
import {
  runtimeActEnvelope,
  runtimeFixtureWithHooks,
} from "./runtime.test-helper.js";
import type { WorldActIngressRejectionReason } from "./actTypes.js";

const request = {
  affordance: "world://pitch/affordance/kick",
  target: "world://pitch/entity/ball",
  input: { force: 1 },
};
const denied = (reason: WorldActIngressRejectionReason) => Object.freeze({
  disposition: "rejected_at_ingress" as const,
  code: "world_action_denied" as const,
  reason,
});
const act = (
  fixture: ReturnType<typeof runtimeFixtureWithHooks>,
  requestId: string,
  decisionToken: string,
) => fixture.runtime!.act(
  { principal: "principal-red", decisionToken },
  runtimeActEnvelope(requestId, request),
);

test("a second public act with a consumed token names the consumed cause", () => {
  const fixture = runtimeFixtureWithHooks({});
  assert.equal(act(fixture, "consume-first", fixture.red.token).disposition, "queued");
  assert.deepEqual(
    act(fixture, "consume-second", fixture.red.token),
    denied("decision_token_consumed"),
  );
});

test("public acts distinguish every invalid decision-token form", () => {
  const unminted = Buffer.from(new Uint8Array(32).fill(99)).toString("base64url");
  const cases = [
    ["missing", ""],
    ["garbled", "not-a-canonical-token"],
    ["unminted", unminted],
  ] as const;
  for (const [name, token] of cases) {
    const fixture = runtimeFixtureWithHooks({});
    assert.deepEqual(
      act(fixture, `invalid-${name}`, token),
      denied("decision_token_invalid"),
      name,
    );
  }

  const foreign = runtimeFixtureWithHooks({});
  assert.deepEqual(
    act(foreign, "invalid-other-principal", foreign.blue.token),
    denied("decision_token_invalid"),
  );
});

test("a public act after the decision window names the expired cause", () => {
  const fixture = runtimeFixtureWithHooks(
    {},
    true,
    { runId: "run-1", worldInstanceId: "instance-1", decisionValidThroughTick: 0 },
  );
  const clock = readWorldRuntimeClockAuthority(fixture.runtime);
  assert.ok(clock);
  clock.stepDynamics();
  assert.deepEqual(
    act(fixture, "expired-after-step", fixture.red.token),
    denied("decision_token_expired"),
  );
});
