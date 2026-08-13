import assert from "node:assert/strict";
import test from "node:test";

import { DecisionRegistryError } from "./index.js";
import { createDecisionRegistryForTesting } from "./decisionRegistry.js";
import type { DecisionPhase, DecisionRegistrySnapshot, DecisionStatus } from "./index.js";

const key = new Uint8Array(32).fill(7);
const config = { runId: "run-1", worldInstanceId: "world-1", tokenDigestKey: key };
const registry = () => createDecisionRegistryForTesting(config, {
  randomBytes: () => new Uint8Array(32).fill(9)
});
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

interface RecordSpec {
  readonly principal: string;
  readonly status: DecisionStatus;
  readonly issuedTick: number;
  readonly validThroughTick: number;
}

const candidate = (
  records: readonly RecordSpec[],
  lastTick: number,
  phase: DecisionPhase = "open",
): DecisionRegistrySnapshot => {
  const snapshot = copy(registry().snapshot()) as unknown as {
    phase: DecisionPhase;
    cutoffTick: number | null;
    admissionsClosedTick: number | null;
    finalizedTick: number | null;
    lastTick: number;
    nextDecisionSequence: number;
    decisions: Record<string, unknown>[];
  };
  snapshot.phase = phase;
  snapshot.cutoffTick = phase === "open" ? null : 1;
  snapshot.admissionsClosedTick = phase === "admissions_closed" || phase === "finalized" ? 2 : null;
  snapshot.finalizedTick = phase === "finalized" ? 3 : null;
  snapshot.lastTick = lastTick;
  snapshot.nextDecisionSequence = records.length + 1;
  snapshot.decisions = records.map((record, index) => ({
    decisionId: `decision-${String(index + 1).padStart(12, "0")}`,
    tokenDigest: `sha256:${String(index + 1).repeat(64)}`,
    ...record,
  }));
  return snapshot as unknown as DecisionRegistrySnapshot;
};

const rejects = (snapshot: DecisionRegistrySnapshot): void => {
  const target = registry();
  const before = target.snapshot();
  assert.throws(
    () => target.restore(snapshot),
    (error: unknown) => error instanceof DecisionRegistryError && error.code === "invalid_snapshot",
  );
  assert.deepEqual(target.snapshot(), before);
  assert(Object.isFrozen(target.snapshot()));
  assert.equal(target.mint({ principal: "probe", issuedTick: 0, validThroughTick: 0 }).decisionId, "decision-000000000001");
};

test("rejects histories whose terminal records cannot produce the final clock event", () => {
  const sweptThenConsumed = [
    { principal: "a", status: "expired", issuedTick: 0, validThroughTick: 0 },
    { principal: "b", status: "consumed", issuedTick: 1, validThroughTick: 1 },
  ] as const;
  const consumedBeforeSuccessor = [
    { principal: "a", status: "consumed", issuedTick: 0, validThroughTick: 5 },
    { principal: "a", status: "consumed", issuedTick: 1, validThroughTick: 1 },
  ] as const;
  for (const phase of ["open", "cutoff"] as const) {
    rejects(candidate(sweptThenConsumed, 2, phase));
    rejects(candidate(consumedBeforeSuccessor, 2, phase));
  }
});

test("rejects unreachable frontier clocks and expired-at-admission histories", () => {
  rejects(candidate([], 2, "cutoff"));
  rejects(candidate([
    { principal: "a", status: "consumed", issuedTick: 0, validThroughTick: 1 }
  ], 2));
  rejects(candidate([
    { principal: "a", status: "expired", issuedTick: 0, validThroughTick: 2 }
  ], 2, "admissions_closed"));
  rejects(candidate([
    { principal: "a", status: "consumed", issuedTick: 0, validThroughTick: 3 }
  ], 3, "admissions_closed"));
  rejects(candidate([
    { principal: "a", status: "consumed", issuedTick: 0, validThroughTick: 3 }
  ], 4, "finalized"));
});

test("accepts terminal consume, read, first-expiry, cutoff, admission, and final events", () => {
  const cases = [
    candidate([{ principal: "a", status: "active", issuedTick: 0, validThroughTick: 2 }], 2),
    candidate([{ principal: "a", status: "consumed", issuedTick: 0, validThroughTick: 2 }], 2),
    candidate([{ principal: "a", status: "expired", issuedTick: 0, validThroughTick: 1 }], 2),
    candidate([], 1, "cutoff"),
    candidate([{ principal: "a", status: "consumed", issuedTick: 0, validThroughTick: 2 }], 2, "admissions_closed"),
    candidate([{ principal: "a", status: "consumed", issuedTick: 0, validThroughTick: 3 }], 3, "finalized"),
  ];
  for (const snapshot of cases) {
    const target = registry();
    target.restore(snapshot);
    assert.deepEqual(target.snapshot(), snapshot);
  }
});

test("enforces strict expired-principal reuse while preserving legal terminal successors", () => {
  for (const status of ["active", "consumed", "expired"] as const) {
    rejects(candidate([
      { principal: "a", status: "expired", issuedTick: 0, validThroughTick: 1 },
      { principal: "a", status, issuedTick: 1, validThroughTick: status === "active" ? 2 : 1 },
    ], 2));
  }
  for (const status of ["active", "consumed", "expired"] as const) {
    const snapshot = candidate([
      { principal: "a", status: "expired", issuedTick: 0, validThroughTick: 1 },
      { principal: "a", status, issuedTick: 2, validThroughTick: 2 },
    ], status === "expired" ? 3 : 2);
    const target = registry();
    target.restore(snapshot);
    assert.equal(target.inspect().decisions[1]?.status, status);
  }
});
