import assert from "node:assert/strict";
import test from "node:test";

import { compileCapabilityManifests } from "./capabilityManifest.js";
import { readWorldRuntimeClockAuthority } from "./clockAuthority.js";
import { parseWorldCheckpoint } from "./checkpoint.js";
import { readWorldRuntimeCheckpointCoordinator } from "./checkpointRuntime.js";
import { createDecisionRegistryForTesting } from "./decisionRegistry.js";
import { issueBoundWorldGrants } from "./grantAttestation.js";
import { createWorldReadLedger } from "./ledger.js";
import { createRestoredWorldRuntime, createWorldRuntime, type CreateWorldRuntimeInput } from "./runtime.js";
import { runtimeActEnvelope, runtimeFixtureWithHooks, type RuntimeFixtureHooks } from "./runtime.test-helper.js";
import * as packageBarrel from "../index.js";
import * as worldBarrel from "./index.js";

const receiptSha = "2".repeat(64);
const identity = {
  runId: "run-1",
  worldInstanceId: "instance-1",
  buildReceiptSha256: receiptSha,
  decisionValidThroughTick: 4,
};
const resultRequest = Object.freeze({
  version: "simfile.world-action-result-page-request.v1" as const,
  limit: 10,
});
const stepForActions = (input: unknown) => {
  const value = input as { readonly tick: number; readonly actions: readonly { readonly sequence: number }[] };
  return {
    tick: value.tick,
    events: [],
    action_results: value.actions.map(({ sequence }) => ({ accepted: true, sequence })),
  };
};

const sourceFixture = (step = stepForActions) => {
  const fixture = runtimeFixtureWithHooks({ step }, false, identity);
  const runtime = createWorldRuntime({
    dynamics: fixture.dynamics,
    surfaceRegistry: fixture.surfaceRegistry,
    capabilityManifests: fixture.capabilityManifests,
    boundGrants: fixture.boundGrants,
    decisionRegistry: fixture.decisionRegistry,
    readLedger: fixture.readLedger,
  });
  const coordinator = readWorldRuntimeCheckpointCoordinator(runtime);
  assert.ok(coordinator);
  return { ...fixture, runtime, coordinator };
};

const freshTarget = (
  failRestore?: () => boolean,
  targetIdentity: NonNullable<Parameters<typeof runtimeFixtureWithHooks>[2]> = identity,
  snapshot?: RuntimeFixtureHooks["snapshot"],
) => {
  const fixture = runtimeFixtureWithHooks({ step: stepForActions, failRestore, snapshot }, false, targetIdentity);
  const decisionRegistry = createDecisionRegistryForTesting({
    runId: targetIdentity.runId,
    worldInstanceId: targetIdentity.worldInstanceId,
    tokenDigestKey: new Uint8Array(32).fill(7),
  }, { randomBytes: () => new Uint8Array(32).fill(71) });
  const readLedger = createWorldReadLedger({ maxEntriesPerPrincipal: 20 });
  const input: CreateWorldRuntimeInput = {
    dynamics: fixture.dynamics,
    surfaceRegistry: fixture.surfaceRegistry,
    capabilityManifests: fixture.capabilityManifests,
    boundGrants: fixture.boundGrants,
    decisionRegistry,
    readLedger,
  };
  return { ...fixture, input, decisionRegistry, readLedger };
};

const attemptNestedConstruction = (target: ReturnType<typeof freshTarget>, checkpoint: unknown) => {
  let published = 0;
  let rejected = 0;
  for (const construct of [
    () => createWorldRuntime(target.input),
    () => createRestoredWorldRuntime(target.input, checkpoint),
  ]) {
    try { construct(); published += 1; } catch { rejected += 1; }
  }
  return { published, rejected };
};

const populatedSource = () => {
  const source = sourceFixture();
  const red = { principal: "principal-red", decisionToken: source.red.token };
  source.runtime.status(red);
  const envelope = runtimeActEnvelope("restore-request", {
    affordance: "world://pitch/affordance/kick",
    target: "world://pitch/entity/ball",
    input: { force: 1 },
  });
  const receipt = source.runtime.act(red, envelope);
  assert.equal(receipt.disposition, "queued");
  assert.deepEqual(readWorldRuntimeClockAuthority(source.runtime)!.stepDynamics(), {
    tick: 0,
    action_results: 1,
    events: 0,
  });
  const next = source.decisionRegistry.mint({ principal: "principal-red", issuedTick: 1, validThroughTick: 4 });
  source.runtime.status({ principal: "principal-red", decisionToken: next.token });
  const resultPage = source.runtime.ledger(red, resultRequest);
  const checkpoint = source.coordinator.capture();
  return { source, checkpoint, envelope, receipt, next, resultPage };
};

test("restores fresh owners exactly without advancing a tick and continues every ledger", () => {
  const { source, checkpoint, envelope, receipt, next, resultPage } = populatedSource();
  const target = freshTarget();
  const beforeCalls = target.dynamicsCalls();
  const runtime = createRestoredWorldRuntime(target.input, checkpoint);
  assert.equal(target.dynamicsCalls(), beforeCalls);
  assert.equal(target.restoreCalls(), 1);
  assert.equal(target.dynamics.nextTick, checkpoint.dynamics.next_tick);
  assert.deepEqual(target.decisionRegistry.snapshot(), checkpoint.decisions);
  assert.deepEqual(target.readLedger.read("principal-red", {}), source.readLedger.read("principal-red", {}));
  assert.deepEqual(readWorldRuntimeCheckpointCoordinator(runtime)!.capture(), checkpoint);
  assert.deepEqual(runtime.act({ principal: "principal-red", decisionToken: source.red.token }, envelope), receipt);
  assert.deepEqual(runtime.ledger({ principal: "principal-red", decisionToken: source.red.token }, resultRequest), resultPage);
  assert.deepEqual(runtime.ledger({ principal: "principal-red", decisionToken: source.red.token }, {
    ...resultRequest,
    result_after: resultPage.next_result_after,
  }), { identity: resultPage.identity, results: [], next_result_after: resultPage.next_result_after });
  for (const operation of [
    () => runtime.status({ principal: "principal-red", decisionToken: source.red.token }),
    () => runtime.capabilities({ principal: "principal-red", decisionToken: source.red.token }),
    () => runtime.observe({ principal: "principal-red", decisionToken: source.red.token }, { sense: "world://pitch/sense/vision" }),
    () => runtime.affordances({ principal: "principal-red", decisionToken: source.red.token }),
    () => runtime.ledger({ principal: "principal-red", decisionToken: source.red.token }, {}),
  ]) assert.throws(operation);
  assert.deepEqual(runtime.act({ principal: "principal-red", decisionToken: source.red.token }, runtimeActEnvelope("restore-other", {
    affordance: "world://pitch/affordance/kick",
    target: "world://pitch/entity/ball",
    input: { force: 2 },
  })), { disposition: "rejected_at_ingress", code: "world_action_denied", reason: "decision_token_consumed" });
  assert.deepEqual(
    runtime.status({ principal: "principal-red", decisionToken: next.token }),
    source.runtime.status({ principal: "principal-red", decisionToken: next.token }),
  );
  assert.deepEqual(readWorldRuntimeClockAuthority(runtime)!.stepDynamics(), { tick: 1, action_results: 0, events: 0 });
  assert.equal(target.dynamics.nextTick, 2);
  assert.throws(() => createWorldRuntime(target.input));
  assert.equal("createRestoredWorldRuntime" in worldBarrel, false);
  assert.equal("createRestoredWorldRuntime" in packageBarrel, false);
});

test("restored pending mechanics execute on the exact next tick with source parity", () => {
  const source = sourceFixture();
  const envelope = runtimeActEnvelope("pending-restore", {
    affordance: "world://pitch/affordance/kick",
    target: "world://pitch/entity/ball",
    input: { force: 1 },
  });
  assert.equal(source.runtime.act({ principal: "principal-red", decisionToken: source.red.token }, envelope).disposition, "queued");
  const checkpoint = source.coordinator.capture();
  const target = freshTarget();
  const runtime = createRestoredWorldRuntime(target.input, checkpoint);
  assert.equal(target.dynamics.nextTick, 0);
  assert.deepEqual(readWorldRuntimeCheckpointCoordinator(runtime)!.capture(), checkpoint);
  const expected = readWorldRuntimeClockAuthority(source.runtime)!.stepDynamics();
  const actual = readWorldRuntimeClockAuthority(runtime)!.stepDynamics();
  assert.deepEqual(actual, expected);
  assert.deepEqual(readWorldRuntimeCheckpointCoordinator(runtime)!.capture(), source.coordinator.capture());
});

test("failed first-owner restore publishes nothing and a completely fresh graph retries", () => {
  const { checkpoint } = populatedSource();
  let fail = true;
  const target = freshTarget(() => {
    if (!fail) return false;
    fail = false;
    return true;
  });
  assert.throws(() => createRestoredWorldRuntime(target.input, checkpoint));
  assert.equal(target.dynamics.nextTick, 0);
  assert.equal(target.decisionRegistry.snapshot().decisions.length, 0);
  assert.equal(target.readLedger.read("principal-red", {}).records.length, 0);
  const retry = freshTarget();
  const runtime = createRestoredWorldRuntime(retry.input, checkpoint);
  assert.deepEqual(readWorldRuntimeCheckpointCoordinator(runtime)!.capture(), checkpoint);
});

test("initial provider snapshot reentry rejects both nested constructors before outer restoration claims owners", () => {
  const { checkpoint } = populatedSource();
  let armed = false;
  let attempts = { published: -1, rejected: -1 };
  let target: ReturnType<typeof freshTarget>;
  target = freshTarget(undefined, identity, () => {
    if (!armed) return;
    armed = false;
    attempts = attemptNestedConstruction(target, checkpoint);
  });
  armed = true;

  const runtime = createRestoredWorldRuntime(target.input, checkpoint);
  assert.deepEqual(attempts, { published: 0, rejected: 2 });
  assert.equal(target.restoreCalls(), 1);
  assert.deepEqual(readWorldRuntimeCheckpointCoordinator(runtime)!.capture(), checkpoint);
  assert.throws(() => createWorldRuntime(target.input));
  assert.throws(() => createRestoredWorldRuntime(target.input, checkpoint));
});

test("provider restore reentry cannot publish shared owners and a failed outer restore releases its lease", () => {
  const { checkpoint } = populatedSource();
  let target: ReturnType<typeof freshTarget>;
  let firstRestore = true;
  let attempts = { published: -1, rejected: -1 };
  target = freshTarget(() => {
    if (!firstRestore) return false;
    firstRestore = false;
    attempts = attemptNestedConstruction(target, checkpoint);
    return true;
  });

  assert.throws(() => createRestoredWorldRuntime(target.input, checkpoint));
  assert.deepEqual(attempts, { published: 0, rejected: 2 });
  assert.equal(target.restoreCalls(), 2);
  assert.equal(target.dynamics.nextTick, 0);
  assert.equal(target.decisionRegistry.snapshot().decisions.length, 0);
  assert.equal(target.readLedger.read("principal-red", {}).records.length, 0);
  assert.ok(createWorldRuntime(target.input));
  assert.throws(() => createWorldRuntime(target.input));
});

test("final recapture snapshot reentry rejects both nested constructors after permanent owner claim", () => {
  const { checkpoint } = populatedSource();
  let afterRestore = false;
  let snapshotsAfterRestore = 0;
  let attempts = { published: -1, rejected: -1 };
  let target: ReturnType<typeof freshTarget>;
  target = freshTarget(() => { afterRestore = true; return false; }, identity, () => {
    if (!afterRestore) return;
    snapshotsAfterRestore += 1;
    if (snapshotsAfterRestore === 3) attempts = attemptNestedConstruction(target, checkpoint);
  });

  const runtime = createRestoredWorldRuntime(target.input, checkpoint);
  assert.equal(snapshotsAfterRestore, 3);
  assert.deepEqual(attempts, { published: 0, rejected: 2 });
  assert.deepEqual(readWorldRuntimeCheckpointCoordinator(runtime)!.capture(), checkpoint);
  assert.throws(() => createWorldRuntime(target.input));
  assert.throws(() => createRestoredWorldRuntime(target.input, checkpoint));
});

test("host preguards reject static, capacity, principal, and closure substitutions before claims", () => {
  const checkpoint = sourceFixture().coordinator.capture();
  const cases: readonly [string, (value: Record<string, any>) => void][] = [
    ["executed artifact", (value) => {
      value.static.executed_artifact_sha256 = "0".repeat(64);
      value.dynamics.provenance.module_sha256 = "0".repeat(64);
    }],
    ["build receipt", (value) => { value.static.dynamics_build_receipt_sha256 = "3".repeat(64); }],
    ["result capacity", (value) => { value.action_result_ledger.max_entries += 1; }],
    ["read capacity", (value) => { value.read_ledger.max_entries_per_principal += 1; }],
    ["journal principals", (value) => { value.action_journal.lanes.pop(); }],
    ["closure", (value) => { value.request_ledger.closed = true; }],
  ];
  for (const [name, change] of cases) {
    const hostile = structuredClone(checkpoint) as Record<string, any>;
    change(hostile);
    assert.ok(parseWorldCheckpoint(hostile), `${name} remains a valid C2 value`);
    const target = freshTarget();
    assert.throws(() => createRestoredWorldRuntime(target.input, hostile), name);
    assert.ok(createWorldRuntime(target.input), `${name} failure did not claim or mutate fresh owners`);
  }
});

test("artifact, build, surface, manifest, and run substitutions reject before publication", () => {
  const checkpoint = sourceFixture().coordinator.capture();
  const cases = [
    ["artifact", { ...identity, moduleSha256: "0".repeat(64) }],
    ["build", { ...identity, buildReceiptSha256: "3".repeat(64) }],
    ["surface", { ...identity, fixedTargets: ["entity:blue"] as const }],
    ["manifest", { ...identity, redAffordances: ["world://pitch/affordance/wait"] as const }],
    ["run", { ...identity, runId: "run-2" }],
  ] as const;
  for (const [name, substituted] of cases) {
    const target = freshTarget(undefined, substituted);
    assert.throws(() => createRestoredWorldRuntime(target.input, checkpoint), name);
    assert.equal(target.dynamics.nextTick, 0);
    assert.equal(target.dynamicsCalls(), 0);
    assert.equal(target.restoreCalls(), 0);
    assert.ok(createWorldRuntime(target.input));
  }
});

test("world identity substitution rejects before publication", () => {
  const checkpoint = sourceFixture().coordinator.capture();
  const target = freshTarget();
  const boundGrants = issueBoundWorldGrants([
    { participant: "blue", principal: "principal-blue", entity: "world://other/entity/blue", senses: ["world://other/sense/blue-view"], affordances: ["world://other/affordance/wait"] },
    { participant: "red", principal: "principal-red", entity: "world://other/entity/red", senses: ["world://other/sense/vision", "world://other/sense/red-detail"], affordances: ["world://other/affordance/kick", "world://other/affordance/wait"] },
  ] as const as never);
  const capabilityManifests = compileCapabilityManifests({
    runId: identity.runId,
    worldInstanceId: identity.worldInstanceId,
    world: { id: "other" as never },
    surfaceRegistry: target.surfaceRegistry,
    grants: boundGrants as never,
  });
  const input = { ...target.input, boundGrants, capabilityManifests };
  assert.throws(() => createRestoredWorldRuntime(input, checkpoint));
  assert.equal(target.dynamics.nextTick, 0);
  assert.equal(target.restoreCalls(), 0);
  assert.ok(createWorldRuntime(input));
});

test("nonfresh dynamics and decision counters reject before claim", () => {
  const checkpoint = sourceFixture().coordinator.capture();
  const advanced = freshTarget();
  assert.deepEqual(advanced.dynamics.step(), { tick: 0, events: [], action_results: [] });
  assert.throws(() => createRestoredWorldRuntime(advanced.input, checkpoint));
  assert.equal(advanced.restoreCalls(), 0);
  assert.ok(createWorldRuntime(advanced.input));

  const minted = freshTarget();
  minted.decisionRegistry.mint({ principal: "principal-red", issuedTick: 0, validThroughTick: 4 });
  assert.throws(() => createRestoredWorldRuntime(minted.input, checkpoint));
  assert.equal(minted.restoreCalls(), 0);
  assert.ok(createWorldRuntime(minted.input));
});

test("inconsistent retained counters reject before restore and leave the same owners fresh", () => {
  const { checkpoint } = populatedSource();
  const hostile = structuredClone(checkpoint) as Record<string, any>;
  hostile.dynamics.next_action_sequence += 1;
  assert.equal(parseWorldCheckpoint(hostile), undefined);
  const target = freshTarget();
  assert.throws(() => createRestoredWorldRuntime(target.input, hostile));
  assert.equal(target.restoreCalls(), 0);
  assert.equal(target.dynamics.nextTick, 0);
  assert.ok(createWorldRuntime(target.input));
});

test("hostile checkpoint rejection invokes no traps and leaves the same inputs publishable", () => {
  let traps = 0;
  const target = freshTarget();
  const hostile = new Proxy({}, { get: () => { traps += 1; throw new Error("trap"); } });
  assert.throws(() => createRestoredWorldRuntime(target.input, hostile));
  assert.equal(traps, 0);
  assert.ok(createWorldRuntime(target.input));
});

test("restores closure as mechanics closure without inferring it from decision phase", () => {
  const source = sourceFixture((input) => {
    const value = input as { readonly tick: number };
    return { tick: value.tick + 1, events: [], action_results: [] };
  });
  assert.throws(() => readWorldRuntimeClockAuthority(source.runtime)!.stepDynamics());
  const checkpoint = source.coordinator.capture();
  assert.equal(checkpoint.action_journal.closed, true);
  assert.equal(checkpoint.request_ledger.closed, true);
  assert.equal(checkpoint.decisions.phase, "open");
  const runtime = createRestoredWorldRuntime(freshTarget().input, checkpoint);
  assert.throws(() => readWorldRuntimeClockAuthority(runtime)!.stepDynamics(), /closed/u);
  assert.deepEqual(readWorldRuntimeCheckpointCoordinator(runtime)!.capture(), checkpoint);
});
