import assert from "node:assert/strict";
import test from "node:test";
import {
  DECISION_REGISTRY_SNAPSHOT_VERSION,
  DecisionRegistryError,
  createDecisionRegistry,
} from "./index.js";
import type { DecisionRegistry, DecisionRegistrySnapshot } from "./index.js";
import { createDecisionRegistryForTesting } from "./decisionRegistry.js";

const key = (offset = 0) => new Uint8Array(Array.from({ length: 32 }, (_, index) => index + offset));
const config = (offset = 0) => ({ runId: "run-1", worldInstanceId: "world-1", tokenDigestKey: key(offset) });
const bytes = (value: number) => new Uint8Array(32).fill(value);
const factory = (...values: number[]) => {
  let index = 0;
  return createDecisionRegistryForTesting(config(), { randomBytes: () => bytes(values[index++] ?? 255) });
};
const limitedFactory = (limit: number, ...values: number[]) => {
  let index = 0;
  return createDecisionRegistryForTesting(config(), { randomBytes: () => bytes(values[index++] ?? 255), maxDecisionSequence: limit });
};
const admission = (token: string, atTick: number, principal = "agent-1") =>
  ({ principal, runId: "run-1", worldInstanceId: "world-1", token, atTick });
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const fails = (fn: () => unknown, code: string) =>
  assert.throws(fn, (value: unknown) => value instanceof DecisionRegistryError && value.code === code);
const failsRedacted = (fn: () => unknown, code: string, token: string) =>
  assert.throws(fn, (value: unknown) => value instanceof DecisionRegistryError && value.code === code && !String(value).includes(token));
const restoreFailsAtomically = (registry: DecisionRegistry, candidate: unknown) => {
  const before = registry.snapshot();
  fails(() => registry.restore(candidate), "invalid_snapshot");
  assert.deepEqual(registry.snapshot(), before);
  assert(Object.isFrozen(registry.snapshot()));
};

test("exports a canonical immutable redacted snapshot", () => {
  const registry = factory(1, 2);
  const first = registry.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 2 });
  registry.consumeForAct(admission(first.token, 1));
  registry.mint({ principal: "agent-1", issuedTick: 1, validThroughTick: 3 });
  const snapshot = registry.snapshot();
  assert.equal(snapshot.version, DECISION_REGISTRY_SNAPSHOT_VERSION);
  assert(Object.isFrozen(snapshot));
  assert(Object.isFrozen(snapshot.decisions));
  assert(Object.isFrozen(snapshot.decisions[0]));
  assert.throws(() => { (snapshot as { phase: string }).phase = "finalized"; });
  assert.throws(() => { (snapshot.decisions as unknown as unknown[]).push({}); });
  assert.deepEqual(registry.snapshot(), snapshot);
  assert(!JSON.stringify(snapshot).includes(first.token));
  assert.match(snapshot.tokenDigestKeyFingerprint, /^sha256:[0-9a-f]{64}$/);
});

test("round trips open, cutoff, admissions closure, and finalization", () => {
  const open = factory(1);
  const openToken = open.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 3 });
  const cutoff = factory(2);
  const cutoffToken = cutoff.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 3 });
  cutoff.beginCutoff(1);
  const closed = factory(3);
  const closedToken = closed.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 1 });
  closed.beginCutoff(2);
  closed.closeAdmissions(2);
  const finalized = factory(4);
  const finalizedToken = finalized.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 0 });
  finalized.beginCutoff(1);
  finalized.closeAdmissions(1);
  finalized.finalize(2);
  for (const [source, token, phase] of [[open, openToken.token, "open"], [cutoff, cutoffToken.token, "cutoff"],
    [closed, closedToken.token, "admissions_closed"], [finalized, finalizedToken.token, "finalized"]] as const) {
    const restored = factory(9);
    const snapshot = source.snapshot();
    restored.restore(snapshot);
    assert.deepEqual(restored.snapshot(), snapshot);
    assert.equal(restored.inspect().phase, phase);
    if (phase === "open") {
      assert.equal(restored.admitRead(admission(token, 1)).decisionId, "decision-000000000001");
      restored.beginCutoff(1);
      assert.equal(restored.inspect().phase, "cutoff");
    } else if (phase === "cutoff") {
      assert.equal(restored.consumeForAct(admission(token, 1)).status, "consumed");
      restored.closeAdmissions(1);
      assert.equal(restored.inspect().phase, "admissions_closed");
    } else if (phase === "admissions_closed") {
      fails(() => restored.admitRead(admission(token, 2)), "admissions_closed");
      restored.finalize(2);
      assert.equal(restored.inspect().phase, "finalized");
    } else fails(() => restored.admitRead(admission(token, 2)), "admissions_closed");
  }
});

test("restored records retain consumption, expiry, binding, and future sequence behavior", () => {
  const consumed = factory(1, 2);
  const first = consumed.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 2 });
  consumed.consumeForAct(admission(first.token, 1));
  const restoredConsumed = factory(3);
  restoredConsumed.restore(consumed.snapshot());
  failsRedacted(() => restoredConsumed.admitRead(admission(first.token, 1)), "token_consumed", first.token);
  assert(!JSON.stringify(restoredConsumed.inspect()).includes(first.token));
  assert.equal(restoredConsumed.mint({ principal: "agent-1", issuedTick: 2, validThroughTick: 2 }).decisionId, "decision-000000000002");

  const expired = factory(4);
  const expiredToken = expired.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 0 });
  fails(() => expired.admitRead(admission(expiredToken.token, 1)), "token_expired");
  const restoredExpired = factory(5);
  restoredExpired.restore(expired.snapshot());
  failsRedacted(() => restoredExpired.admitRead(admission(expiredToken.token, 1)), "token_expired", expiredToken.token);
  assert(!JSON.stringify(restoredExpired.inspect()).includes(expiredToken.token));
  assert.equal(restoredExpired.mint({ principal: "agent-1", issuedTick: 1, validThroughTick: 1 }).decisionId, "decision-000000000002");
});

test("restore is one-time, pristine-only, and rejects configuration conflicts", () => {
  const source = factory(1);
  source.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 0 });
  const snapshot = source.snapshot();
  const restored = factory(2);
  restored.restore(snapshot);
  fails(() => restored.restore(snapshot), "restore_not_pristine");
  const changed = factory(3);
  changed.beginCutoff(0);
  fails(() => changed.restore(snapshot), "restore_not_pristine");
  for (const candidate of [{ ...copy(snapshot), version: "other" }, { ...copy(snapshot), runId: "run-2" },
    { ...copy(snapshot), worldInstanceId: "world-2" }, { ...copy(snapshot), tokenDigestKeyFingerprint: "sha256:".padEnd(71, "0") }]) {
    restoreFailsAtomically(factory(4), candidate);
  }
  const wrongKey = createDecisionRegistryForTesting(config(1), { randomBytes: () => bytes(5) });
  restoreFailsAtomically(wrongKey, snapshot);
});

test("rejects hostile structure and every candidate rejection preserves a usable empty registry", () => {
  const source = factory(1, 2);
  source.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 2 });
  source.mint({ principal: "agent-2", issuedTick: 1, validThroughTick: 2 });
  const valid = source.snapshot();
  const accessor = copy(valid) as unknown as Record<string, unknown>;
  Object.defineProperty(accessor, "version", { enumerable: true, get: () => { throw new Error("getter invoked"); } });
  const sparse = copy(valid) as unknown as { decisions: unknown[] };
  delete sparse.decisions[0];
  const symbol = copy(valid) as unknown as Record<PropertyKey, unknown>;
  symbol[Symbol("extra")] = true;
  const hidden = copy(valid) as unknown as Record<string, unknown>;
  Object.defineProperty(hidden, "hidden", { enumerable: false, value: true });
  const outOfOrder = copy(valid) as unknown as { decisions: unknown[] };
  outOfOrder.decisions.reverse();
  const additional = { ...copy(valid), additional: true };
  const badArray = copy(valid) as unknown as { decisions: unknown };
  badArray.decisions = new Date();
  for (const candidate of [undefined, null, [], new Date(), accessor, sparse, symbol, hidden, outOfOrder, additional, badArray]) {
    assert.doesNotThrow(() => restoreFailsAtomically(factory(7), candidate));
  }
  const usable = factory(8);
  restoreFailsAtomically(usable, additional);
  assert.equal(usable.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 0 }).decisionId, "decision-000000000001");
});

test("rejects transparent, throwing, and reentrant proxies without invoking traps", () => {
  const source = factory(1, 2);
  source.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 2 });
  source.mint({ principal: "agent-2", issuedTick: 1, validThroughTick: 2 });
  const valid = source.snapshot();
  const candidates = [
    () => new Proxy(copy(valid), {}),
    () => ({ ...copy(valid), decisions: new Proxy(copy(valid.decisions), {}) }),
    () => ({ ...copy(valid), decisions: [new Proxy(copy(valid.decisions[0]!), {})] }),
  ];
  for (const makeCandidate of candidates) restoreFailsAtomically(factory(3), makeCandidate());
  for (const layer of ["top", "array", "record"] as const) {
    const target = factory(4);
    let traps = 0;
    const source = layer === "top" ? copy(valid) :
      layer === "array" ? copy(valid.decisions) : copy(valid.decisions[0]!);
    const hostile = new Proxy(source, {
      getPrototypeOf: () => {
        traps += 1;
        target.mint({ principal: "attacker", issuedTick: 0, validThroughTick: 0 });
        throw new Error("trap");
      },
    });
    const candidate = layer === "top" ? hostile : layer === "array" ? { ...copy(valid), decisions: hostile } :
      { ...copy(valid), decisions: [hostile, copy(valid.decisions[1]!)] };
    restoreFailsAtomically(target, candidate);
    assert.equal(traps, 0);
    assert.equal(target.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 0 }).decisionId, "decision-000000000001");
  }
});

test("rejects malformed records, duplicate identity material, and lifecycle impossibilities", () => {
  const source = factory(1, 2);
  source.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 3 });
  source.mint({ principal: "agent-2", issuedTick: 1, validThroughTick: 3 });
  const valid = source.snapshot();
  const mutate = (change: (value: Record<string, unknown>) => void) => {
    const candidate = copy(valid) as unknown as Record<string, unknown>;
    change(candidate);
    restoreFailsAtomically(factory(3), candidate);
  };
  mutate((value) => { (value.decisions as Record<string, unknown>[])[0]!.decisionId = "decision-000000000000"; });
  mutate((value) => { (value.decisions as Record<string, unknown>[])[0]!.tokenDigest = "sha256:bad"; });
  mutate((value) => { (value.decisions as Record<string, unknown>[])[0]!.status = "unknown"; });
  mutate((value) => { (value.decisions as Record<string, unknown>[])[0]!.issuedTick = -1; });
  mutate((value) => { (value.decisions as Record<string, unknown>[])[0]!.issuedTick = Number.MAX_SAFE_INTEGER + 1; });
  mutate((value) => { (value.decisions as Record<string, unknown>[])[0]!.validThroughTick = 0; });
  mutate((value) => { (value.decisions as Record<string, unknown>[])[0]!.status = "expired"; });
  mutate((value) => { (value.decisions as Record<string, unknown>[])[1]!.decisionId = "decision-000000000001"; });
  mutate((value) => { (value.decisions as Record<string, unknown>[])[1]!.tokenDigest = (value.decisions as Record<string, unknown>[])[0]!.tokenDigest; });
  mutate((value) => { (value.decisions as Record<string, unknown>[])[1]!.principal = "agent-1"; });
  mutate((value) => { value.nextDecisionSequence = 1; });
  mutate((value) => { value.nextDecisionSequence = -1; });
  mutate((value) => { value.lastTick = 0; });
  mutate((value) => { value.lastTick = Number.MAX_SAFE_INTEGER + 1; });
  mutate((value) => {
    value.phase = "admissions_closed";
    value.cutoffTick = 1;
    value.admissionsClosedTick = 1;
  });
  mutate((value) => { value.phase = "cutoff"; });
  mutate((value) => { value.cutoffTick = 2; });
  mutate((value) => {
    (value.decisions as Record<string, unknown>[])[1]!.decisionId = "decision-000000000003";
    value.nextDecisionSequence = 4;
  });
  mutate((value) => {
    const decisions = value.decisions as Record<string, unknown>[];
    decisions[0]!.issuedTick = 1;
    decisions[1]!.issuedTick = 0;
  });
  mutate((value) => {
    const decisions = value.decisions as Record<string, unknown>[];
    decisions[1]!.principal = decisions[0]!.principal;
    decisions[1]!.status = "consumed";
  });
  mutate((value) => {
    value.decisions = [];
    value.nextDecisionSequence = 1;
    value.lastTick = 0;
  });
});

test("permits historical principal reuse and proves contiguous restored exhaustion without oversized ids", () => {
  const source = factory(1, 2);
  const first = source.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 1 });
  source.consumeForAct(admission(first.token, 1));
  source.mint({ principal: "agent-1", issuedTick: 1, validThroughTick: 2 });
  const historical = factory(3);
  historical.restore(source.snapshot());
  assert.equal(historical.inspect().decisions.length, 2);
  const exhaustedSource = limitedFactory(2, 4, 5);
  const consumed = exhaustedSource.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 1 });
  exhaustedSource.consumeForAct(admission(consumed.token, 1));
  exhaustedSource.mint({ principal: "agent-1", issuedTick: 1, validThroughTick: 1 });
  const exhausted = exhaustedSource.snapshot();
  assert.deepEqual(exhausted.decisions.map(({ decisionId }) => decisionId), ["decision-000000000001", "decision-000000000002"]);
  const exhaustedRegistry = limitedFactory(2, 6);
  exhaustedRegistry.restore(exhausted);
  const before = exhaustedRegistry.snapshot();
  fails(() => exhaustedRegistry.mint({ principal: "agent-2", issuedTick: 1, validThroughTick: 1 }), "sequence_exhausted");
  assert.deepEqual(exhaustedRegistry.snapshot(), before);
  assert.equal(exhaustedRegistry.snapshot().nextDecisionSequence, 3);
});

test("restoration clones caller-owned data and every hostile failure remains redacted", () => {
  const source = factory(1);
  const minted = source.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 1 });
  const candidate = copy(source.snapshot()) as unknown as { decisions: Record<string, unknown>[] };
  const restored = factory(2);
  restored.restore(candidate);
  candidate.decisions[0]!.principal = "changed";
  assert.equal(restored.inspect().decisions[0]?.principal, "agent-1");
  const secret = minted.token;
  for (const hostile of [new Proxy(copy(source.snapshot()), {}), { ...copy(source.snapshot()), decisions: new Proxy([], {}) }]) {
    assert.throws(() => restored.restore(hostile), (value: unknown) => value instanceof DecisionRegistryError && !String(value).includes(secret));
  }
});

test("key and entropy byte validation never invokes hostile typed-array properties", () => {
  const decorate = <T extends Uint8Array>(value: T) => {
    let accesses = 0;
    for (const key of ["byteLength", "length", "constructor", Symbol.iterator]) {
      Object.defineProperty(value, key, {
        configurable: true,
        get: () => {
          accesses += 1;
          return undefined;
        },
      });
    }
    return { value, accesses: () => accesses };
  };
  for (const input of [decorate(bytes(1)), decorate(Buffer.from(bytes(2)))]) {
    const registry = createDecisionRegistry({ ...config(), tokenDigestKey: input.value });
    registry.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 0 });
    assert.equal(input.accesses(), 0);
  }
  for (const input of [decorate(bytes(3)), decorate(Buffer.from(bytes(4)))]) {
    const registry = createDecisionRegistryForTesting(config(), { randomBytes: () => input.value });
    registry.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 0 });
    assert.equal(input.accesses(), 0);
  }
});

test("key and entropy byte validation rejects altered prototypes without invoking traps", () => {
  class ByteSubclass extends Uint8Array {}
  const hostileValues = () => {
    let traps = 0;
    const custom = bytes(1);
    Object.setPrototypeOf(custom, {});
    const proxyPrototype = bytes(2);
    Object.setPrototypeOf(proxyPrototype, new Proxy({}, {
      get: () => {
        traps += 1;
        return undefined;
      },
    }));
    return { values: [new ByteSubclass(32), custom, proxyPrototype], traps: () => traps };
  };
  const configured = hostileValues();
  for (const tokenDigestKey of configured.values) {
    fails(() => createDecisionRegistry({ ...config(), tokenDigestKey }), "invalid_config");
  }
  assert.equal(configured.traps(), 0);
  const entropy = hostileValues();
  for (const output of entropy.values) {
    const registry = createDecisionRegistryForTesting(config(), { randomBytes: () => output });
    fails(() => registry.mint({ principal: "agent-1", issuedTick: 0, validThroughTick: 0 }), "entropy_failure");
    assert.equal(registry.inspect().nextDecisionSequence, 1);
  }
  assert.equal(entropy.traps(), 0);
});
