import assert from "node:assert/strict";
import test from "node:test";
import {
  DecisionRegistryError,
  createDecisionRegistryForTesting,
  readDecisionActReservation,
  readDecisionRegistryErrorCode,
  reserveDecisionForAct,
} from "./decisionRegistry.js";

const config = () => ({
  runId: "run",
  worldInstanceId: "world",
  tokenDigestKey: new Uint8Array(32).fill(1),
});
const registry = (...bytes: number[]) => {
  let index = 0;
  return createDecisionRegistryForTesting(config(), {
    randomBytes: () => new Uint8Array(32).fill(bytes[index++] ?? 99),
  });
};
const admission = (token: string, atTick = 0, overrides = {}) => ({
  principal: "p", runId: "run", worldInstanceId: "world", token, atTick, ...overrides,
});
const fails = (operation: () => unknown, code: string) => assert.throws(
  operation,
  (value: unknown) => value instanceof DecisionRegistryError && value.code === code,
);
const mint = (value: ReturnType<typeof registry>, principal = "p", validThroughTick = 4) =>
  value.mint({ principal, issuedTick: 0, validThroughTick });

test("abort preserves the exact open snapshot and releases the exclusive lock", () => {
  const value = registry(1);
  const minted = mint(value);
  const before = value.snapshot();
  const reservation = reserveDecisionForAct(value, admission(minted.token));
  fails(() => value.mint({ principal: "other", issuedTick: 0, validThroughTick: 0 }), "invalid_input");
  fails(() => value.peekReadAdmission(admission(minted.token)), "invalid_input");
  reservation.abort();
  assert.deepEqual(value.snapshot(), before);
  assert.equal(value.inspect().decisions[0]!.status, "active");
  assert.equal(value.consumeForAct(admission(minted.token)).status, "consumed");
});

test("abort preserves the exact cutoff snapshot and cutoff remains admissible", () => {
  const value = registry(1);
  const minted = mint(value, "p", 2);
  value.beginCutoff(1);
  const before = value.snapshot();
  const reservation = reserveDecisionForAct(value, admission(minted.token, 1));
  reservation.abort();
  assert.deepEqual(value.snapshot(), before);
  assert.equal(value.inspect().phase, "cutoff");
  assert.equal(value.consumeForAct(admission(minted.token, 1)).status, "consumed");
});

test("commit installs the consumed result and sweeps unrelated expired decisions", () => {
  const value = registry(1, 2);
  const consumed = mint(value, "p", 3);
  mint(value, "other", 1);
  const reservation = reserveDecisionForAct(value, admission(consumed.token, 2));
  reservation.commit();
  assert.deepEqual(value.inspect().decisions.map(({ status }) => status), ["consumed", "expired"]);
  assert.equal(value.inspect().lastTick, 2);
});

test("every registry operation is locked until abort or commit", () => {
  const value = registry(1);
  const minted = mint(value);
  const reservation = reserveDecisionForAct(value, admission(minted.token));
  const operations: readonly (() => unknown)[] = [
    () => value.mint({ principal: "other", issuedTick: 0, validThroughTick: 0 }),
    () => value.peekReadAdmission(admission(minted.token)),
    () => value.admitRead(admission(minted.token)),
    () => value.consumeForAct(admission(minted.token)),
    () => value.beginCutoff(0),
    () => value.closeAdmissions(0),
    () => value.finalize(0),
    () => value.inspect(),
    () => value.snapshot(),
    () => value.restore({}),
  ];
  for (const operation of operations) fails(operation, "invalid_input");
  reservation.commit();
  assert.equal(value.inspect().decisions[0]!.status, "consumed");
});

test("rejects wrong bindings, tokens, ticks, and lifecycle admissions", () => {
  const value = registry(1, 2, 3, 4, 5, 6);
  const minted = mint(value, "p", 4);
  const cases: readonly [unknown, string][] = [
    [admission(minted.token, 0, { principal: "other" }), "token_invalid"],
    [admission(minted.token, 0, { runId: "other" }), "token_invalid"],
    [admission(minted.token, 0, { worldInstanceId: "other" }), "token_invalid"],
    [admission(Buffer.from(new Uint8Array(32).fill(55)).toString("base64url")), "token_invalid"],
    [admission("not-a-token"), "invalid_input"],
    [admission(minted.token, -1), "invalid_input"],
    [admission(minted.token, 5), "token_expired"],
  ];
  for (const [input, code] of cases) fails(() => reserveDecisionForAct(value, input), code);

  const consumed = registry(7);
  const consumedMint = mint(consumed);
  consumed.consumeForAct(admission(consumedMint.token));
  fails(() => reserveDecisionForAct(consumed, admission(consumedMint.token)), "token_consumed");

  const closed = registry(8);
  const closedMint = mint(closed, "p", 0);
  closed.beginCutoff(1);
  closed.closeAdmissions(1);
  fails(() => reserveDecisionForAct(closed, admission(closedMint.token, 1)), "admissions_closed");
  closed.finalize(2);
  fails(() => reserveDecisionForAct(closed, admission(closedMint.token, 2)), "admissions_closed");
});

test("expired reservations retain state while legacy consumeForAct performs its sweep", () => {
  const value = registry(1, 2);
  const expired = mint(value, "p", 0);
  mint(value, "other", 0);
  const before = value.snapshot();
  fails(() => reserveDecisionForAct(value, admission(expired.token, 1)), "token_expired");
  assert.deepEqual(value.snapshot(), before);
  fails(() => value.consumeForAct(admission(expired.token, 1)), "token_expired");
  assert.deepEqual(value.inspect().decisions.map(({ status }) => status), ["expired", "expired"]);
});

test("all first-operation combinations become stale and fail closed", () => {
  for (const first of ["commit", "abort"] as const) {
    for (const second of ["commit", "abort"] as const) {
      const value = registry(1);
      const minted = mint(value);
      const reservation = reserveDecisionForAct(value, admission(minted.token));
      reservation[first]();
      fails(() => reservation[second](), "token_invalid");
      fails(() => reservation.commit(), "token_invalid");
      fails(() => reservation.abort(), "token_invalid");
    }
  }
});

test("reservation issuance and use reject structural lookalikes", () => {
  const value = registry(1);
  const minted = mint(value);
  const real = reserveDecisionForAct(value, admission(minted.token));
  assert.equal(readDecisionActReservation(real), real);
  const lookalike = { decisionId: real.decisionId, commit: real.commit, abort: real.abort };
  assert.equal(readDecisionActReservation(lookalike), undefined);
  assert.equal(readDecisionActReservation({ decisionId: real.decisionId, commit() {}, abort() {} }), undefined);
  fails(() => reserveDecisionForAct({ ...value }, admission(minted.token)), "invalid_input");
  real.abort();
});

test("decision registry error codes reject structural and prototype lookalikes", () => {
  const real = new DecisionRegistryError("token_invalid");
  assert.equal(readDecisionRegistryErrorCode(real), "token_invalid");
  assert.equal(readDecisionRegistryErrorCode({ code: "token_invalid" }), undefined);
  const prototypeLookalike = Object.assign(
    Object.create(DecisionRegistryError.prototype) as object,
    { code: "token_invalid" },
  );
  assert.equal(prototypeLookalike instanceof DecisionRegistryError, true);
  assert.equal(readDecisionRegistryErrorCode(prototypeLookalike), undefined);
});

test("legacy consumeForAct preserves status and expired sweep compatibility", () => {
  const value = registry(1, 2);
  const first = mint(value, "p", 2);
  mint(value, "other", 0);
  const result = value.consumeForAct(admission(first.token, 1));
  assert.deepEqual(result, {
    decisionId: first.decisionId,
    principal: "p",
    runId: "run",
    worldInstanceId: "world",
    status: "consumed",
    issuedTick: 0,
    validThroughTick: 2,
    tokenDigest: value.inspect().decisions[0]!.tokenDigest,
  });
  assert.equal(value.inspect().decisions[1]!.status, "expired");
  fails(() => value.consumeForAct(admission(first.token, 1)), "token_consumed");
});
