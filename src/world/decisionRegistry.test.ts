import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import * as world from "./index.js";
import { DecisionRegistryError, createDecisionRegistry, createDecisionRegistryForTesting } from "./decisionRegistry.js";
import type { DecisionRegistry, DecisionRegistryErrorCode } from "./decisionRegistry.js";

const key = () => new Uint8Array(Array.from({ length: 32 }, (_, index) => index));
const config = () => ({ runId: "run-1", worldInstanceId: "world-1", tokenDigestKey: key() });
const bytes = (value: number) => new Uint8Array(32).fill(value);
const factory = (...values: number[]) => { let index = 0; return createDecisionRegistryForTesting(config(), { randomBytes: () => bytes(values[index++] ?? 255) }); };
const admission = (token: string, atTick: number, overrides = {}) =>
  ({ principal: "agent-1", runId: "run-1", worldInstanceId: "world-1", token, atTick, ...overrides });
const fails = (fn: () => unknown, code: string) => assert.throws(fn, (value: unknown) => value instanceof DecisionRegistryError && value.code === code);
const failsAtomically = (registry: DecisionRegistry, fn: () => unknown, code: string) => { const before = registry.inspect();
  fails(fn, code);
  assert.deepEqual(registry.inspect(), before); };

test("mints deterministic canonical tokens and retains only the specified HMAC digest", () => {
  const registry = factory(7);
  const minted = registry.mint({ principal: "agent-1", issuedTick: 4, validThroughTick: 8 });
  const expectedDigest = `sha256:${createHmac("sha256", key()).update("simfile.decision-token.v1\0run-1\0").update(minted.token).digest("hex")}`;
  assert.equal(minted.token, Buffer.from(bytes(7)).toString("base64url"));
  assert.equal(registry.inspect().decisions[0]?.tokenDigest, expectedDigest);
  assert.match(minted.decisionId, /^decision-000000000001$/);
  assert.equal(Buffer.from(minted.token, "base64url").byteLength, 32);
  assert.equal((world as Record<string, unknown>).createDecisionRegistryForTesting, undefined);
});

test("production entropy and copied configuration key do not expose mutable key material", () => {
  const mutableKey = key();
  const registry = createDecisionRegistry({ runId: "run-1", worldInstanceId: "world-1", tokenDigestKey: mutableKey });
  const minted = registry.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 1 });
  const before = registry.inspect().decisions[0]?.tokenDigest;
  mutableKey.fill(99);
  assert.equal(registry.admitRead(admission(minted.token, 0)).tokenDigest, before);
  assert.equal(Buffer.from(minted.token, "base64url").byteLength, 32);
  assert.equal(Buffer.from(minted.token, "base64url").toString("base64url"), minted.token);
});

test("rejects malformed inputs, entropy failures, and collision exhaustion without allocating ids", () => {
  for (const bad of [undefined, null, {}, { ...config(), tokenDigestKey: new Uint8Array(31) }, { ...config(), runId: " " }, { ...config(), worldInstanceId: "" }]) {
    fails(() => createDecisionRegistry(bad), "invalid_config");
  }
  for (const entropy of [() => undefined as unknown as Uint8Array, () => new Uint8Array(31), () => ({} as Uint8Array), () => { throw new Error("private"); }]) {
    const registry = createDecisionRegistryForTesting(config(), { randomBytes: entropy });
    fails(() => registry.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 0 }), "entropy_failure");
    assert.equal(registry.inspect().nextDecisionSequence, 1);
  }
  const registry = factory(3, ...Array<number>(16).fill(3), 4);
  registry.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 0 });
  fails(() => registry.mint({ principal: "agent-2", issuedTick: 1, validThroughTick: 1 }), "entropy_failure");
  assert.equal(registry.inspect().nextDecisionSequence, 2);
  assert.equal(registry.mint({ principal: "agent-2", issuedTick: 2, validThroughTick: 2 }).decisionId, "decision-000000000002");
  const malformed = factory(1);
  for (const bad of [{}, { principal: "", issuedTick: 0, validThroughTick: 0 },
    { principal: "x", issuedTick: -1, validThroughTick: 0 }, { principal: "x", issuedTick: 1, validThroughTick: 0 },
    { principal: "x", issuedTick: Number.MAX_SAFE_INTEGER + 1, validThroughTick: 2 }]) {
    fails(() => malformed.mint(bad), "invalid_input");
  }
});

test("core parsers reject proxies and accessors without running hostile code or leaking values", () => {
  const secret = Buffer.from(bytes(44)).toString("base64url");
  const configAccessor = () => {
    const value = config() as Record<string, unknown>;
    Object.defineProperty(value, "runId", {
      enumerable: true,
      get: () => { throw new Error(secret); },
    });
    return value;
  };
  const optionsAccessor = () => {
    const value: Record<string, unknown> = {};
    Object.defineProperty(value, "randomBytes", {
      enumerable: true,
      get: () => { throw new Error(secret); },
    });
    return value;
  };
  for (const makeConfig of [configAccessor, () => new Proxy(config(), { getPrototypeOf: () => { throw new Error(secret); } })]) {
    assert.throws(() => createDecisionRegistry(makeConfig()), (value: unknown) =>
      value instanceof DecisionRegistryError && value.code === "invalid_config" && !String(value).includes(secret));
  }
  for (const options of [optionsAccessor(), new Proxy({ randomBytes: () => bytes(1) }, { getPrototypeOf: () => { throw new Error(secret); } })]) {
    assert.throws(() => createDecisionRegistryForTesting(config(), options), (value: unknown) =>
      value instanceof DecisionRegistryError && value.code === "invalid_config" && !String(value).includes(secret));
  }
  const registry = factory(1, 2);
  const minted = registry.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 1 });
  const accessor: Record<string, unknown> = { issuedTick: 0, validThroughTick: 0 };
  Object.defineProperty(accessor, "principal", { enumerable: true, get: () => { throw new Error(secret); } });
  const hostileAdmission: Record<string, unknown> = { principal: "agent-1", runId: "run-1", worldInstanceId: "world-1", atTick: 0 };
  Object.defineProperty(hostileAdmission, "token", { enumerable: true, get: () => { throw new Error(secret); } });
  for (const operation of [() => registry.mint(accessor), () => registry.admitRead(hostileAdmission), () => registry.mint(new Proxy({ principal: "agent-2", issuedTick: 0, validThroughTick: 0 }, { getPrototypeOf: () => { throw new Error(secret); } })),
    () => registry.admitRead(new Proxy(admission(minted.token, 0), { getPrototypeOf: () => { throw new Error(secret); } }))]) {
    const before = registry.snapshot();
    assert.throws(operation, (value: unknown) => value instanceof DecisionRegistryError && value.code === "invalid_input" && !String(value).includes(secret));
    assert.deepEqual(registry.snapshot(), before);
  }
  assert.equal(registry.admitRead(admission(minted.token, 0)).status, "active");
});

test("entropy reentrancy is redacted, atomic, and clears every mutator guard", () => {
  const token = Buffer.from(bytes(9)).toString("base64url");
  const mutators: readonly ((registry: DecisionRegistry) => void)[] = [
    (registry) => { registry.mint({ principal: "nested", issuedTick: 0, validThroughTick: 0 }); },
    (registry) => { registry.admitRead(admission(token, 0)); },
    (registry) => { registry.consumeForAct(admission(token, 0)); },
    (registry) => { registry.beginCutoff(0); },
    (registry) => { registry.closeAdmissions(0); },
    (registry) => { registry.finalize(0); },
    (registry) => { registry.restore({}); },
  ];
  for (const caught of [false, true]) {
    for (const attack of mutators) {
      let registry: DecisionRegistry;
      let hostile = true;
      let caughtCode: string | undefined;
      registry = createDecisionRegistryForTesting(config(), {
        randomBytes: () => {
          if (hostile) {
            hostile = false;
            if (caught) {
              try {
                attack(registry);
              } catch (cause) {
                caughtCode = cause instanceof DecisionRegistryError ? cause.code : undefined;
              }
            } else {
              attack(registry);
            }
          }
          return bytes(7);
        },
      });
      const before = registry.snapshot();
      assert.throws(
        () => registry.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 0 }),
        (cause: unknown) => cause instanceof DecisionRegistryError && cause.code === "entropy_failure" &&
          !String(cause).includes(token),
      );
      assert.equal(caught ? caughtCode : undefined, caught ? "invalid_input" : undefined);
      assert.deepEqual(registry.snapshot(), before);
      assert.equal(registry.snapshot().nextDecisionSequence, 1);
      assert.equal(registry.snapshot().decisions.length, 0);
      assert.equal(
        registry.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 0 }).decisionId,
        "decision-000000000001",
      );
    }
  }
});

test("keeps every rejected operation state-atomic", () => {
  const registry = factory(1, 2);
  const minted = registry.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 4 });
  failsAtomically(registry, () => registry.admitRead({}), "invalid_input");
  failsAtomically(registry, () => registry.mint({}), "invalid_input");
  failsAtomically(registry, () => registry.beginCutoff(-1), "invalid_input");
  failsAtomically(registry, () => registry.admitRead(admission(Buffer.from(bytes(9)).toString("base64url"), 1)), "token_invalid");
  failsAtomically(registry, () => registry.admitRead(admission(minted.token, 1, { principal: "agent-2" })), "token_invalid");
  failsAtomically(registry, () => registry.admitRead(admission(minted.token, 1, { runId: "run-2" })), "token_invalid");
  failsAtomically(registry, () => registry.admitRead(admission(minted.token, 1, { worldInstanceId: "world-2" })), "token_invalid");
  failsAtomically(registry, () => registry.mint({ principal: "agent-1", issuedTick: 1, validThroughTick: 4 }), "active_decision_exists");
  registry.admitRead(admission(minted.token, 1));
  failsAtomically(registry, () => registry.mint({ principal: "agent-2", issuedTick: 0, validThroughTick: 0 }), "tick_regression");
  failsAtomically(registry, () => registry.closeAdmissions(1), "invalid_transition");
  registry.consumeForAct(admission(minted.token, 1));
  failsAtomically(registry, () => registry.consumeForAct(admission(minted.token, 1)), "token_consumed");
  registry.beginCutoff(1);
  failsAtomically(registry, () => registry.beginCutoff(1), "invalid_transition");
  failsAtomically(registry, () => registry.mint({ principal: "agent-2", issuedTick: 1, validThroughTick: 1 }), "mint_closed");

  const active = factory(3);
  active.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 4 });
  active.beginCutoff(1);
  failsAtomically(active, () => active.closeAdmissions(1), "active_decisions_remain");

  const entropy = createDecisionRegistryForTesting(config(), { randomBytes: () => { throw new Error("private"); } });
  failsAtomically(entropy, () => entropy.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 0 }), "entropy_failure");
  const collisions = factory(4, ...Array<number>(16).fill(4));
  collisions.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 0 });
  failsAtomically(collisions, () => collisions.mint({ principal: "agent-2", issuedTick: 1, validThroughTick: 1 }), "entropy_failure");
});

test("validates bindings, canonical tokens, monotonic ticks, inclusive expiry, and first-act consumption", () => {
  const registry = factory(1, 2, 3);
  const minted = registry.mint({ principal: "agent-1", issuedTick: 2, validThroughTick: 4 });
  for (const [bad, code] of [[admission(minted.token, 2, { principal: "agent-2" }), "token_invalid"],
    [admission(minted.token, 2, { runId: "run-2" }), "token_invalid"],
    [admission(minted.token, 2, { worldInstanceId: "world-2" }), "token_invalid"],
    [admission(Buffer.from(bytes(99)).toString("base64url"), 2), "token_invalid"], [admission("bad", 2), "invalid_input"],
    [admission(minted.token, -1), "invalid_input"]] as const) {
    fails(() => registry.admitRead(bad), code);
  }
  assert.equal(registry.admitRead(admission(minted.token, 4)).status, "active");
  assert.equal(registry.consumeForAct(admission(minted.token, 4)).status, "consumed");
  fails(() => registry.consumeForAct(admission(minted.token, 4)), "token_consumed");
  assert.equal(registry.inspect().decisions[0]?.status, "consumed");
  fails(() => registry.admitRead(admission(minted.token, 3)), "tick_regression");
  const expiry = registry.mint({ principal: "agent-1", issuedTick: 5, validThroughTick: 5 });
  fails(() => registry.admitRead(admission(expiry.token, 6)), "token_expired");
  assert.equal(registry.inspect().decisions[1]?.status, "expired");
});

test("repeated reads stay active while expired act consumption performs the expiry transition", () => {
  const registry = factory(1);
  const minted = registry.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 0 });
  assert.equal(registry.admitRead(admission(minted.token, 0)).status, "active");
  assert.equal(registry.admitRead(admission(minted.token, 0)).status, "active");
  fails(() => registry.consumeForAct(admission(minted.token, 1)), "token_expired");
  assert.deepEqual(registry.inspect().decisions.map(({ status }) => status), ["expired"]);
});

test("permits one active decision per principal and preserves consumed or expired history", () => {
  const registry = factory(1, 2, 3);
  const first = registry.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 2 });
  fails(() => registry.mint({ principal: "agent-1", issuedTick: 1, validThroughTick: 2 }), "active_decision_exists");
  registry.consumeForAct(admission(first.token, 1));
  registry.mint({ principal: "agent-1", issuedTick: 2, validThroughTick: 2 });
  const later = registry.mint({ principal: "agent-2", issuedTick: 3, validThroughTick: 3 });
  fails(() => registry.admitRead(admission(later.token, 4, { principal: "agent-2" })), "token_expired");
  registry.mint({ principal: "agent-2", issuedTick: 4, validThroughTick: 4 });
  assert.deepEqual(registry.inspect().decisions.map((record) => record.status), ["consumed", "expired", "expired", "active"]);
});

test("enforces C/A/F, records frontiers, and preserves pre-cutoff admission", () => {
  const registry = factory(1, 2);
  const minted = registry.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 3 });
  fails(() => registry.closeAdmissions(1), "invalid_transition");
  fails(() => registry.finalize(1), "invalid_transition");
  registry.beginCutoff(1);
  fails(() => registry.mint({ principal: "agent-2", issuedTick: 1, validThroughTick: 1 }), "mint_closed");
  assert.equal(registry.admitRead(admission(minted.token, 1)).decisionId, minted.decisionId);
  fails(() => registry.closeAdmissions(2), "active_decisions_remain");
  registry.consumeForAct(admission(minted.token, 2));
  registry.closeAdmissions(2);
  fails(() => registry.admitRead(admission(minted.token, 2)), "admissions_closed");
  fails(() => registry.mint({ principal: "agent-2", issuedTick: 2, validThroughTick: 2 }), "mint_closed");
  fails(() => registry.beginCutoff(2), "invalid_transition");
  registry.finalize(3);
  fails(() => registry.finalize(3), "invalid_transition");
  fails(() => registry.mint({ principal: "agent-2", issuedTick: 3, validThroughTick: 3 }), "mint_closed");
  fails(() => registry.admitRead(admission(minted.token, 3)), "admissions_closed");
  const view = registry.inspect();
  assert.deepEqual([view.cutoffTick, view.admissionsClosedTick, view.finalizedTick], [1, 2, 3]);
});

test("cutoff can close only after expiry sweeps its final active decision", () => {
  const registry = factory(1);
  registry.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 0 });
  registry.beginCutoff(0);
  fails(() => registry.closeAdmissions(0), "active_decisions_remain");
  registry.closeAdmissions(1);
  assert.equal(registry.inspect().decisions[0]?.status, "expired");
});

test("cutoff sweeps expiry as part of its successful transition", () => {
  const registry = factory(1);
  registry.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 0 });
  registry.beginCutoff(1);
  const inspection = registry.inspect();
  assert.equal(inspection.lastTick, 1);
  assert.equal(inspection.cutoffTick, 1);
  assert.equal(inspection.decisions[0]?.status, "expired");
});

test("rejects act and read admission after both admissions closure and finalization", () => {
  const registry = factory(1);
  const minted = registry.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 0 });
  registry.beginCutoff(1);
  registry.closeAdmissions(1);
  for (const operation of [registry.admitRead, registry.consumeForAct]) {
    failsAtomically(registry, () => operation.call(registry, admission(minted.token, 1)), "admissions_closed");
  }
  registry.finalize(2);
  for (const operation of [registry.admitRead, registry.consumeForAct]) {
    failsAtomically(registry, () => operation.call(registry, admission(minted.token, 2)), "admissions_closed");
  }
});

test("requests exactly 32 bytes of entropy for every token draw", () => {
  const sizes: number[] = [];
  const registry = createDecisionRegistryForTesting(config(), {
    randomBytes: (size: number) => {
      sizes.push(size);
      return bytes(6);
    },
  });
  registry.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 0 });
  fails(() => registry.mint({ principal: "agent-2", issuedTick: 1, validThroughTick: 1 }), "entropy_failure");
  assert.equal(sizes.length, 17);
  assert(sizes.every((size) => size === 32));
});

test("keeps every exported error code and redacted message stable", () => {
  const expected: readonly (readonly [DecisionRegistryErrorCode, string])[] = [
    ["invalid_config", "Invalid decision registry configuration."],
    ["invalid_input", "Invalid decision registry input."],
    ["tick_regression", "Decision registry tick regressed."],
    ["mint_closed", "Decision minting is closed."],
    ["active_decision_exists", "An active decision already exists for this principal."],
    ["entropy_failure", "Decision token entropy failed."],
    ["token_invalid", "Decision token admission failed."],
    ["token_expired", "Decision token has expired."],
    ["token_consumed", "Decision token has already been consumed."],
    ["admissions_closed", "Decision admissions are closed."],
    ["invalid_transition", "Invalid decision registry phase transition."],
    ["active_decisions_remain", "Active decisions remain."],
    ["invalid_snapshot", "Invalid decision registry snapshot."],
    ["restore_not_pristine", "Decision registry restore requires a pristine registry."],
    ["sequence_exhausted", "Decision registry sequence is exhausted."],
  ];
  for (const [code, message] of expected) {
    const failure = new DecisionRegistryError(code);
    assert.equal(failure.code, code);
    assert.equal(failure.message, message);
  }
});

test("inspects non-ASCII principals in issued decision-id order without locale collation", () => {
  const registry = factory(1, 2, 3);
  const principals = ["\u00e9clair", "\u3042\u3044", "\u00c5ngstr\u00f6m"];
  for (const principal of principals) registry.mint({ principal, issuedTick: 0, validThroughTick: 0 });
  const descriptor = Object.getOwnPropertyDescriptor(String.prototype, "localeCompare");
  assert(descriptor);
  Object.defineProperty(String.prototype, "localeCompare", { ...descriptor, value: () => { throw new Error("locale used"); } });
  try {
    const decisions = registry.inspect().decisions;
    assert.deepEqual(decisions.map(({ decisionId }) => decisionId), [
      "decision-000000000001", "decision-000000000002", "decision-000000000003",
    ]);
    assert.deepEqual(decisions.map(({ principal }) => principal), principals);
  } finally {
    Object.defineProperty(String.prototype, "localeCompare", descriptor);
  }
});

test("inspection and admissions are frozen and every public value is redacted", () => {
  const registry = factory(9);
  const minted = registry.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 1 });
  const admitted = registry.admitRead(admission(minted.token, 0));
  const inspection = registry.inspect();
  assert(Object.isFrozen(admitted));
  assert(Object.isFrozen(inspection));
  assert(Object.isFrozen(inspection.decisions));
  assert(Object.isFrozen(inspection.decisions[0]));
  assert.throws(() => { (admitted as { status: string }).status = "expired"; });
  for (const value of [admitted, inspection, registry.inspect()]) assert(!JSON.stringify(value).includes(minted.token));
  try { registry.admitRead(admission(minted.token, 2)); } catch (error) {
    assert(!String(error).includes(minted.token));
  }
});

test("peekReadAdmission validates without mutating or exposing admission secrets", () => {
  const assertUnchanged = (registry: DecisionRegistry, operation: () => unknown, code?: string) => {
    const before = registry.snapshot();
    if (code === undefined) operation(); else fails(operation, code);
    assert.deepEqual(registry.snapshot(), before);
  };
  const registry = factory(1, 2);
  const minted = registry.mint({ principal: "agent-1", issuedTick: 2, validThroughTick: 4 });
  let result: ReturnType<DecisionRegistry["peekReadAdmission"]> | undefined;
  assertUnchanged(registry, () => { result = registry.peekReadAdmission(admission(minted.token, 2)); });
  assert.deepEqual(result, { decisionId: minted.decisionId, status: "active", issuedTick: 2, validThroughTick: 4, phase: "open" });
  assert(result && Object.isFrozen(result));
  assert.throws(() => { (result as { status: string }).status = "expired"; });
  assert(!JSON.stringify(result).includes(minted.token));
  assert(!("tokenDigest" in result) && !("token" in result));
  registry.beginCutoff(3);
  assertUnchanged(registry, () => { result = registry.peekReadAdmission(admission(minted.token, 3)); });
  assert.equal(result?.phase, "cutoff");
  for (const [input, code] of [
    [{}, "invalid_input"],
    [admission(minted.token, 2), "tick_regression"],
    [admission(minted.token, 3, { principal: "agent-2" }), "token_invalid"],
    [admission(minted.token, 3, { runId: "run-2" }), "token_invalid"],
    [admission(minted.token, 3, { worldInstanceId: "world-2" }), "token_invalid"],
    [admission(Buffer.from(bytes(9)).toString("base64url"), 3), "token_invalid"],
    [admission(minted.token, 1), "tick_regression"],
    [admission(minted.token, 5), "token_expired"],
  ] as const) assertUnchanged(registry, () => registry.peekReadAdmission(input), code);

  const expired = factory(3);
  const expiredMint = expired.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 0 });
  fails(() => expired.admitRead(admission(expiredMint.token, 1)), "token_expired");
  assertUnchanged(expired, () => expired.peekReadAdmission(admission(expiredMint.token, 1)), "token_expired");
  const consumed = factory(4);
  const consumedMint = consumed.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 1 });
  consumed.consumeForAct(admission(consumedMint.token, 0));
  assertUnchanged(consumed, () => consumed.peekReadAdmission(admission(consumedMint.token, 0)), "token_consumed");
  const closed = factory(5);
  const closedMint = closed.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 0 });
  closed.beginCutoff(1); closed.closeAdmissions(1);
  assertUnchanged(closed, () => closed.peekReadAdmission(admission(closedMint.token, 1)), "admissions_closed");
  closed.finalize(1);
  assertUnchanged(closed, () => closed.peekReadAdmission(admission(closedMint.token, 1)), "admissions_closed");
});
