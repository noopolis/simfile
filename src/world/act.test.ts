import assert from "node:assert/strict";
import test from "node:test";
import { WORLD_ACT_INGRESS_REJECTION_REASONS } from "../world-surface/index.js";
import { encodeWorldActEnvelope } from "./actEnvelope.js";
import { denyWith } from "./act.js";
import { runtimeActEnvelope, runtimeFixture, runtimeFixtureWithHooks } from "./runtime.test-helper.js";
import type { WorldActIngressRejectionReason } from "./actTypes.js";

const context = (token: string) => ({ principal: "principal-red", decisionToken: token });
const request = { affordance: "world://pitch/affordance/kick", target: "world://pitch/entity/ball", input: { force: 1 } };
const denied = (reason: WorldActIngressRejectionReason, fieldPath?: string) => Object.freeze({
  disposition: "rejected_at_ingress" as const,
  code: "world_action_denied" as const,
  reason,
  ...(fieldPath === undefined ? {} : { field_path: fieldPath }),
});

test("queues once and exact retry returns the original receipt", () => {
  const fixture = runtimeFixture();
  const bytes = runtimeActEnvelope("first-action", request);
  const first = fixture.runtime.act(context(fixture.red.token), bytes);
  assert.equal(first.disposition, "queued");
  assert.deepEqual(fixture.runtime!.act(context(fixture.red.token), bytes), first);
});

test("malformed and non-native bytes receive only generic ingress denial", () => {
  const malformed: unknown[] = [
    new Uint8Array(),
    new TextEncoder().encode("not-json\n"),
    Uint8Array.from(runtimeActEnvelope("mutated", request), (byte, index) => index === 0 ? byte ^ 1 : byte),
    new Proxy(runtimeActEnvelope("proxy", request), {}),
    { 0: 1, length: 1 },
  ];
  class ByteSubclass extends Uint8Array {}
  malformed.push(new ByteSubclass(runtimeActEnvelope("subclass", request)));
  for (const bytes of malformed) {
    const fixture = runtimeFixture();
    assert.deepEqual(fixture.runtime!.act(context(fixture.red.token), bytes as never), denied("request_malformed"));
  }
});

test("lowering failure aborts the claim so an identical request id can retry", () => {
  let hostile = true;
  const fixture = runtimeFixtureWithHooks({ lower: () => {
    if (hostile) throw new Error("lower");
    return { force: 1 };
  } });
  const bytes = runtimeActEnvelope("retry-after-lowering", request);
  assert.deepEqual(fixture.runtime!.act(context(fixture.red.token), bytes), denied("world_surface_failed"));
  hostile = false;
  assert.equal(fixture.runtime!.act(context(fixture.red.token), bytes).disposition, "queued");
});

test("encoder owns hostile semantic values while runtime accepts only bytes", () => {
  const getter = { request_id: "hostile", affordance: request.affordance, target: request.target } as Record<string, unknown>;
  Object.defineProperty(getter, "input", { enumerable: true, get: () => { throw new Error("request getter"); } });
  assert.throws(() => encodeWorldActEnvelope(getter), TypeError);
});

test("rejection vocabulary and denyWith remain closed and bounded", () => {
  assert.equal(Object.isFrozen(WORLD_ACT_INGRESS_REJECTION_REASONS), true);
  assert.equal(new Set(WORLD_ACT_INGRESS_REJECTION_REASONS).size, WORLD_ACT_INGRESS_REJECTION_REASONS.length);
  assert.deepEqual(denyWith("not-in-vocabulary"), denied("internal_error"));
  assert.deepEqual(denyWith("request_malformed", "safe.<script>PWNED</script>"), denied("internal_error"));
  assert.deepEqual(denyWith("request_malformed", `safe.${"x".repeat(256)}`), denied("internal_error"));
});
