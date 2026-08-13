import assert from "node:assert/strict";
import test from "node:test";
import type { WorldActIngressRejectionReason } from "./actTypes.js";
import { runtimeActionJournalSnapshot, runtimeActEnvelope, runtimeFixtureWithHooks } from "./runtime.test-helper.js";

const denied = (reason: WorldActIngressRejectionReason, fieldPath?: string) => Object.freeze({
  disposition: "rejected_at_ingress" as const,
  code: "world_action_denied" as const,
  reason,
  ...(fieldPath === undefined ? {} : { field_path: fieldPath }),
});
const context = (token: string) => ({ principal: "principal-red", decisionToken: token });
const action = (affordance = "world://pitch/affordance/kick", target = "world://pitch/entity/ball", input: unknown = { force: 1 }) => ({ affordance, target, input });

const assertDenied = (
  fixture: ReturnType<typeof runtimeFixtureWithHooks>,
  bytes: Uint8Array,
  callbacks: () => number,
  reason: WorldActIngressRejectionReason,
): void => {
  const beforeDynamics = fixture.dynamics.snapshot();
  const beforeDecision = fixture.decisionRegistry.snapshot();
  assert.deepEqual(fixture.runtime!.act(context(fixture.red.token), bytes), denied(reason));
  assert.equal(fixture.dynamics.nextTick, beforeDynamics.next_tick);
  assert.deepEqual(fixture.dynamics.snapshot(), beforeDynamics);
  assert.deepEqual(fixture.decisionRegistry.snapshot(), beforeDecision);
  assert.equal(callbacks(), 0);
  const journal = runtimeActionJournalSnapshot(fixture.runtime);
  assert.ok(journal);
  assert.deepEqual(journal.cells, []);
  assert.deepEqual(journal.audits, [{ principal: "principal-red", result: "denied" }]);
};

const queueLater = (fixture: ReturnType<typeof runtimeFixtureWithHooks>): void => {
  const receipt = fixture.runtime!.act(context(fixture.red.token), runtimeActEnvelope("after-denial", action()));
  assert.equal(receipt.disposition, "queued");
  assert.equal(fixture.dynamics.snapshot().pending_actions.length, 1);
  assert.equal(runtimeActionJournalSnapshot(fixture.runtime)!.cells[0]!.state, "authorized");
};

test("hostile and malformed bytes are denied at real-session ingress", () => {
  class ByteSubclass extends Uint8Array {}
  const makeCases = (): readonly { readonly name: string; readonly bytes: unknown; readonly reason: WorldActIngressRejectionReason }[] => {
    const valid = runtimeActEnvelope("malformed", action());
    const mutated = Uint8Array.from(valid);
    mutated[0] ^= 1;
    return [
      { name: "empty", bytes: new Uint8Array(), reason: "request_malformed" },
      { name: "invalid json", bytes: new TextEncoder().encode("not-json\n"), reason: "request_malformed" },
      { name: "changed canonical bytes", bytes: mutated, reason: "request_malformed" },
      { name: "proxy", bytes: new Proxy(valid, {}), reason: "request_malformed" },
      { name: "subclass", bytes: new ByteSubclass(valid), reason: "request_malformed" },
      { name: "object compatibility route", bytes: { 0: valid[0], length: valid.length }, reason: "request_malformed" },
    ];
  };
  for (const requestCase of makeCases()) {
    let callbacks = 0;
    const fixture = runtimeFixtureWithHooks({
      observe: () => { callbacks += 1; return { channels: [] }; },
      project: () => { callbacks += 1; return { channels: [] }; },
      available: () => { callbacks += 1; return true; },
      lower: () => { callbacks += 1; return { force: 1 }; },
    });
    assert.doesNotThrow(() => assertDenied(fixture, requestCase.bytes as never, () => callbacks, requestCase.reason), requestCase.name);
    queueLater(fixture);
  }
});

const admissionCases: readonly { readonly name: string; readonly request: unknown; readonly reason: WorldActIngressRejectionReason; readonly identity?: Parameters<typeof runtimeFixtureWithHooks>[2] }[] = [
  { name: "malformed affordance", request: action("not-an-affordance"), reason: "affordance_not_granted" },
  { name: "foreign affordance", request: action("world://other/affordance/kick"), reason: "affordance_not_granted" },
  { name: "wrong-kind resource", request: action("world://pitch/entity/ball"), reason: "affordance_not_granted" },
  { name: "ungranted affordance", identity: { runId: "run-1", worldInstanceId: "instance-1", redAffordances: ["world://pitch/affordance/kick"] }, request: action("world://pitch/affordance/wait", "world://pitch/entity/red"), reason: "affordance_not_granted" },
  { name: "holder target mismatch", request: action("world://pitch/affordance/wait", "world://pitch/entity/ball"), reason: "target_not_granted" },
  { name: "fixed target mismatch", request: action("world://pitch/affordance/kick", "world://pitch/entity/red"), reason: "target_not_granted" },
  { name: "declared but ungranted target", request: action("world://pitch/affordance/kick", "world://pitch/entity/blue"), reason: "target_not_granted" },
];

test("manifest and selector admission precede every checked callback", () => {
  for (const admissionCase of admissionCases) {
    let callbacks = 0;
    const fixture = runtimeFixtureWithHooks({
      observe: () => { callbacks += 1; return { channels: [] }; },
      project: () => { callbacks += 1; return { channels: [] }; },
      available: () => { callbacks += 1; return true; },
      lower: () => { callbacks += 1; return { force: 1 }; },
    }, true, admissionCase.identity);
    assertDenied(fixture, runtimeActEnvelope(`admission-${admissionCase.name}`, admissionCase.request as never), () => callbacks, admissionCase.reason);
    queueLater(fixture);
  }
});

test("unknown principal receives no action-journal audit", () => {
  const fixture = runtimeFixtureWithHooks({ observe: () => { throw new Error("must not run"); } });
  const beforeDynamics = fixture.dynamics.snapshot();
  const beforeDecision = fixture.decisionRegistry.snapshot();
  assert.deepEqual(fixture.runtime!.act({ principal: "principal-unknown", decisionToken: fixture.red.token }, runtimeActEnvelope("unknown-principal", action())), denied("principal_unknown"));
  assert.deepEqual(fixture.dynamics.snapshot(), beforeDynamics);
  assert.deepEqual(fixture.decisionRegistry.snapshot(), beforeDecision);
  const journal = runtimeActionJournalSnapshot(fixture.runtime);
  assert.ok(journal);
  assert.deepEqual(journal.audits, []);
  assert.deepEqual(journal.cells, []);
});

test("real runtime refusals distinguish missing, bounded, and grant causes", () => {
  const fixture = runtimeFixtureWithHooks({});
  const missing = fixture.runtime!.act(context(fixture.red.token), runtimeActEnvelope("missing-input", action(undefined, undefined, {})));
  const bounded = fixture.runtime!.act(context(fixture.red.token), runtimeActEnvelope("bounded-input", action(undefined, undefined, { force: 2 })));
  const ungranted = fixture.runtime!.act(context(fixture.red.token), runtimeActEnvelope("ungranted-input", action("world://pitch/affordance/absent")));

  assert.deepEqual(missing, denied("action_input_missing_field", "force"));
  assert.deepEqual(bounded, denied("action_input_out_of_bounds", "force"));
  assert.deepEqual(ungranted, denied("affordance_not_granted"));
  const reasons = [missing, bounded, ungranted].map((receipt) =>
    receipt.disposition === "rejected_at_ingress" ? receipt.reason : "queued");
  assert.equal(new Set(reasons).size, 3);
});

test("hostile input keys and values never enter rejection receipts", () => {
  const fixture = runtimeFixtureWithHooks({});
  const hostileKey = "<script>PWNED</script>";
  const hostileValue = "<img src=x onerror=PWNED>";
  const unknown = fixture.runtime!.act(context(fixture.red.token), runtimeActEnvelope("hostile-unknown", action(
    undefined,
    undefined,
    { force: 1, [hostileKey]: hostileValue },
  )));
  assert.deepEqual(unknown, denied("action_input_out_of_bounds"));
  assert.equal(Object.hasOwn(unknown, "field_path"), false);
  assert.equal(JSON.stringify(unknown).includes(hostileKey), false);
  assert.equal(JSON.stringify(unknown).includes(hostileValue), false);

  const declared = fixture.runtime!.act(context(fixture.red.token), runtimeActEnvelope("hostile-declared", action(
    undefined,
    undefined,
    { force: hostileValue },
  )));
  assert.deepEqual(declared, denied("action_input_wrong_type", "force"));
  assert.equal(JSON.stringify(declared).includes(hostileValue), false);
});
