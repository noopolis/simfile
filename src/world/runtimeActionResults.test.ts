import assert from "node:assert/strict";
import test from "node:test";

import { WorldRuntimeError } from "./ledger.js";
import { readWorldActionResultLedger } from "./actionResultLedger.js";
import { readWorldRuntimeClockAuthority } from "./clockAuthority.js";
import { runtimeActionResultLedger, runtimeActionJournalSnapshot, runtimeActionJournalStatus, runtimeActEnvelope, runtimeFixtureWithHooks, runtimeRequestLedgerSnapshot } from "./runtime.test-helper.js";
import * as worldBarrel from "./index.js";
import * as packageBarrel from "../index.js";

const resultRequest: { readonly version: "simfile.world-action-result-page-request.v1"; readonly limit: number } = Object.freeze({ version: "simfile.world-action-result-page-request.v1", limit: 100 });
const redContext = (token: string) => ({ principal: "principal-red", decisionToken: token });
const blueContext = (token: string) => ({ principal: "principal-blue", decisionToken: token });
const denied = (call: () => unknown, secrets: readonly string[] = []): void => assert.throws(call, (error: unknown) => {
  if (!(error instanceof WorldRuntimeError) || error.code !== "world_runtime_denied") return false;
  return secrets.every((secret) => !error.message.includes(secret));
});
const ingressDenied = (reason: "decision_token_consumed" | "ingress_reentered" | "ingress_closed") => Object.freeze({
  disposition: "rejected_at_ingress" as const,
  code: "world_action_denied" as const,
  reason,
});
const stepForActions = (input: unknown) => ({ tick: (input as { readonly tick: number }).tick, events: [], action_results: (input as { readonly actions: readonly { readonly sequence: number }[] }).actions.map(({ sequence }) => ({ accepted: true, sequence })) });
const queue = (fixture: ReturnType<typeof runtimeFixtureWithHooks>, token: string, requestId: string, principal = "principal-red") => fixture.runtime!.act(
  principal === "principal-red" ? redContext(token) : blueContext(token),
  runtimeActEnvelope(requestId, principal === "principal-red"
    ? { affordance: "world://pitch/affordance/kick", target: "world://pitch/entity/ball", input: { force: 1 } }
    : { affordance: "world://pitch/affordance/wait", target: "world://pitch/entity/blue", input: { force: 1 } }),
);

test("runtime-owned result reads follow the real checked session and terminal ordering", () => {
  const fixture = runtimeFixtureWithHooks({
    step: (input) => {
      const actions = (input as { readonly actions: readonly { readonly sequence: number }[] }).actions;
      return { tick: 0, events: [{ cause_action_sequences: [actions[0]!.sequence], kind: "impact", payload: { strength: 1 }, source: "system:test", target: "object:ball" }], action_results: actions.map(({ sequence }) => ({ accepted: true, sequence })) };
    },
  });
  const runtime = fixture.runtime!;
  const handle = runtimeActionResultLedger(runtime);
  assert.ok(handle);
  assert.throws(() => runtime.ledger(redContext(fixture.red.token), resultRequest), WorldRuntimeError);
  const receipt = runtime.act(redContext(fixture.red.token), runtimeActEnvelope("runtime-result", { affordance: "world://pitch/affordance/kick", target: "world://pitch/entity/ball", input: { force: 1 } }));
  assert.equal(receipt.disposition, "queued");
  assert.equal(fixture.dynamics.nextTick, 0);
  const callsBeforeRead = fixture.dynamicsCalls();
  assert.equal(runtime.ledger(redContext(fixture.red.token), resultRequest).results.length, 0);
  assert.equal(fixture.dynamicsCalls(), callsBeforeRead);
  assert.deepEqual(runtime.ledger(redContext(fixture.red.token), { ...resultRequest, limit: 1 }), { identity: runtime.ledger(redContext(fixture.red.token), resultRequest).identity, results: [] });
  const clock = readWorldRuntimeClockAuthority(runtime)!;
  assert.deepEqual(clock.stepDynamics(), { tick: 0, action_results: 1, events: 1 });
  const callsAfterStep = fixture.dynamicsCalls();
  const page = runtime.ledger(redContext(fixture.red.token), resultRequest);
  assert.equal(page.results.length, 1);
  const result = page.results[0]!;
  assert.equal(result.receipt_id, receipt.receipt_id);
  assert.equal(result.decision_id, receipt.decision_id);
  assert.equal(result.action_sequence, 1);
  assert.equal(result.result_id, "world-result-1");
  assert.equal(result.status, "applied");
  assert.deepEqual((result as Extract<typeof result, { status: "applied" }>).caused_effect_ids, ["world-effect-1"]);
  assert.equal(result.identity.state_version, 1);
  assert.equal(Object.isFrozen(page), true);
  assert.equal(Object.isFrozen(page.results), true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.identity), true);
  assert.ok(page.next_result_after && Object.isFrozen(page.next_result_after));
  assert.throws(() => (page.next_result_after as { after: number }).after = 99, TypeError);
  assert.deepEqual(runtime.ledger(redContext(fixture.red.token), resultRequest), page, "public pages and cursor values are cloned/frozen");
  assert.deepEqual(runtimeActionJournalSnapshot(runtime)!.cells[0]!.terminal?.receipt_id, receipt.receipt_id);
  assert.equal(fixture.dynamicsCalls(), callsAfterStep);
});

test("consumed admission is exclusive to the matching result page and replays read-only", () => {
  const fixture = runtimeFixtureWithHooks({ step: (input) => ({ tick: 0, events: [], action_results: (input as { readonly actions: readonly { readonly sequence: number }[] }).actions.map(({ sequence }) => ({ accepted: true, sequence })) }) });
  const runtime = fixture.runtime!;
  const receipt = runtime.act(redContext(fixture.red.token), runtimeActEnvelope("route-matrix", { affordance: "world://pitch/affordance/kick", target: "world://pitch/entity/ball", input: { force: 1 } }));
  assert.equal(receipt.disposition, "queued");
  const clock = readWorldRuntimeClockAuthority(runtime)!;
  clock.stepDynamics();
  const first = runtime.ledger(redContext(fixture.red.token), resultRequest);
  const dynamicsCalls = fixture.dynamicsCalls();
  for (const request of [undefined, {}, { limit: 100 }, { version: resultRequest.version, limit: 100, extra: true }]) {
    assert.throws(() => runtime.ledger(redContext(fixture.red.token), request), WorldRuntimeError);
  }
  const auditAfterDeniedRoutes = fixture.readLedger.read("principal-red", {});
  assert.deepEqual(runtime.ledger(redContext(fixture.red.token), resultRequest), first);
  assert.equal(fixture.dynamicsCalls(), dynamicsCalls);
  assert.deepEqual(fixture.readLedger.read("principal-red", {}), auditAfterDeniedRoutes);
  assert.throws(() => runtime.ledger({ principal: "principal-blue", decisionToken: fixture.blue.token }, resultRequest), WorldRuntimeError);
  assert.throws(() => runtime.ledger({ principal: "principal-red", decisionToken: fixture.blue.token }, resultRequest), WorldRuntimeError);
});

test("consumed tokens cannot use any active-token operation or cross runtime result authority", () => {
  const fixture = runtimeFixtureWithHooks({ step: (input) => ({ tick: 0, events: [], action_results: (input as { readonly actions: readonly { readonly sequence: number }[] }).actions.map(({ sequence }) => ({ accepted: true, sequence })) }) });
  const runtime = fixture.runtime!;
  const envelope = runtimeActEnvelope("exclusive-act", { affordance: "world://pitch/affordance/kick", target: "world://pitch/entity/ball", input: { force: 1 } });
  assert.equal(runtime.act(redContext(fixture.red.token), envelope).disposition, "queued");
  readWorldRuntimeClockAuthority(runtime)!.stepDynamics();
  for (const operation of [
    () => runtime.status(redContext(fixture.red.token)),
    () => runtime.capabilities(redContext(fixture.red.token)),
    () => runtime.observe(redContext(fixture.red.token), {}),
    () => runtime.affordances(redContext(fixture.red.token)),
    () => runtime.ledger(redContext(fixture.red.token), {}),
  ]) assert.throws(operation, WorldRuntimeError);
  assert.deepEqual(runtime.act(redContext(fixture.red.token), runtimeActEnvelope("different-act", { affordance: "world://pitch/affordance/kick", target: "world://pitch/entity/ball", input: { force: 2 } })), ingressDenied("decision_token_consumed"));

  const other = runtimeFixtureWithHooks({});
  assert.throws(() => other.runtime!.ledger(redContext(fixture.red.token), resultRequest), WorldRuntimeError);
});

test("result route rejects hostile shapes and keeps private authority out of runtime values", () => {
  const fixture = runtimeFixtureWithHooks({});
  const runtime = fixture.runtime!;
  const handle = runtimeActionResultLedger(runtime)!;
  assert.deepEqual(Reflect.ownKeys(runtime), ["status", "capabilities", "observe", "affordances", "ledger", "act"]);
  assert.deepEqual(Reflect.ownKeys(handle), ["read"]);
  assert.equal(Object.isFrozen(handle), true);
  const trapped = { version: resultRequest.version, get limit() { throw new Error("getter"); } };
  assert.throws(() => runtime.ledger(redContext(fixture.red.token), trapped), WorldRuntimeError);
  const proxy = new Proxy(resultRequest, { get: () => { throw new Error("proxy"); } });
  assert.throws(() => runtime.ledger(redContext(fixture.red.token), proxy), WorldRuntimeError);
  assert.throws(() => runtime.ledger(redContext(fixture.red.token), { version: resultRequest.version, limit: 0 }), WorldRuntimeError);
  assert.equal("reserveBatch" in runtime, false);
  assert.equal("createWorldActionResultLedger" in runtime, false);
  for (const name of ["reserve", "reserveBatch", "publish", "abort", "exportState", "importState", "secret", "key", "issuer", "admission", "store", "authority"]) {
    assert.equal(name in runtime, false, name);
    assert.equal(name in handle, false, name);
    assert.equal(name in worldBarrel, false, name);
    assert.equal(name in packageBarrel, false, name);
  }
});

test("active and consumed decisions have the complete public route matrix without secret diagnostics", () => {
  const fixture = runtimeFixtureWithHooks({ step: stepForActions });
  const runtime = fixture.runtime!;
  const active = redContext(fixture.red.token);
  const callsBefore = fixture.dynamicsCalls();
  assert.equal(runtime.status(active).decision.id, fixture.red.decisionId);
  assert.equal(runtime.capabilities(active).manifest.holder.principal, "principal-red");
  assert.equal(runtime.observe(active, { sense: "world://pitch/sense/vision" }).sense, "world://pitch/sense/vision");
  assert.equal(runtime.affordances(active).affordances.length, 2);
  assert.ok(runtime.ledger(active, {}).records.length >= 4);
  denied(() => runtime.ledger(active, resultRequest), [fixture.red.token, "sha256:", "issuer", "registry", "key"]);
  assert.equal(fixture.dynamicsCalls(), callsBefore + 3, "result and legacy-ledger reads add no mechanics calls");
  const receipt = queue(fixture, fixture.red.token, "matrix-consume");
  assert.equal(receipt.disposition, "queued");
  readWorldRuntimeClockAuthority(runtime)!.stepDynamics();
  const consumed = redContext(fixture.red.token);
  for (const operation of [
    () => runtime.status(consumed), () => runtime.capabilities(consumed),
    () => runtime.observe(consumed, { sense: "world://pitch/sense/vision" }),
    () => runtime.affordances(consumed), () => runtime.ledger(consumed, {}),
  ]) denied(operation, [fixture.red.token]);
  assert.deepEqual(queue(fixture, fixture.red.token, "matrix-second"), ingressDenied("decision_token_consumed"));
  const page = runtime.ledger(consumed, resultRequest);
  assert.deepEqual(page.results.map((result) => result.receipt_id), [receipt.receipt_id]);
});

test("public result admission covers malformed, swapped, foreign, expired, and phase-bound decisions", () => {
  const fixture = runtimeFixtureWithHooks({ step: stepForActions });
  const runtime = fixture.runtime!;
  assert.equal(queue(fixture, fixture.red.token, "admission-open").disposition, "queued");
  readWorldRuntimeClockAuthority(runtime)!.stepDynamics();
  assert.equal(runtime.ledger(redContext(fixture.red.token), resultRequest).results.length, 1);
  for (const context of [
    redContext("malformed"), redContext(fixture.blue.token), blueContext(fixture.red.token),
    { principal: "principal-unknown", decisionToken: fixture.red.token },
  ]) denied(() => runtime.ledger(context, resultRequest), [fixture.red.token, fixture.blue.token, "sha256:", "issuer", "registry", "key"]);
  let differentRunEntropy = 31;
  const differentRun = runtimeFixtureWithHooks({ step: stepForActions, randomBytes: () => new Uint8Array(32).fill(differentRunEntropy++) }, true, { runId: "run-2", worldInstanceId: "instance-1" });
  denied(() => differentRun.runtime!.ledger(redContext(fixture.red.token), resultRequest), [fixture.red.token]);
  let differentInstanceEntropy = 32;
  const differentInstance = runtimeFixtureWithHooks({ step: stepForActions, randomBytes: () => new Uint8Array(32).fill(differentInstanceEntropy++) }, true, { runId: "run-1", worldInstanceId: "instance-2" });
  denied(() => differentInstance.runtime!.ledger(redContext(fixture.red.token), resultRequest), [fixture.red.token]);

  const cutoff = runtimeFixtureWithHooks({ step: stepForActions });
  assert.equal(queue(cutoff, cutoff.red.token, "admission-cutoff").disposition, "queued");
  readWorldRuntimeClockAuthority(cutoff.runtime!)!.stepDynamics();
  cutoff.decisionRegistry.beginCutoff(1);
  assert.equal(cutoff.runtime!.ledger(redContext(cutoff.red.token), resultRequest).results.length, 1);

  const closed = runtimeFixtureWithHooks({ step: stepForActions }, true, { runId: "run-1", worldInstanceId: "instance-1", decisionValidThroughTick: 0 });
  assert.equal(queue(closed, closed.red.token, "admission-closed").disposition, "queued");
  const closedClock = readWorldRuntimeClockAuthority(closed.runtime!)!;
  closedClock.stepDynamics();
  closed.decisionRegistry.beginCutoff(1); closed.decisionRegistry.closeAdmissions(1);
  denied(() => closed.runtime!.ledger(redContext(closed.red.token), resultRequest), [closed.red.token]);
  closed.decisionRegistry.finalize(1);
  denied(() => closed.runtime!.ledger(redContext(closed.red.token), resultRequest), [closed.red.token]);

  const expired = runtimeFixtureWithHooks({ step: stepForActions });
  assert.equal(queue(expired, expired.red.token, "admission-expired").disposition, "queued");
  const expiredClock = readWorldRuntimeClockAuthority(expired.runtime!)!;
  expiredClock.stepDynamics(); expiredClock.stepDynamics(); expiredClock.stepDynamics();
  denied(() => expired.runtime!.ledger(redContext(expired.red.token), resultRequest), [expired.red.token]);
  // Manifest substitution is unreachable through the six-key runtime API; see
  // decisionResultReadAdmission.test.ts "binding substitutions, cross-issued authorities, and hostile shapes fail closed".
});

test("result polling is byte-stable, state-pure, and denies cross-runtime cursors without mutation", () => {
  const fixture = runtimeFixtureWithHooks({ step: stepForActions });
  assert.equal(queue(fixture, fixture.red.token, "poll-snapshot").disposition, "queued");
  readWorldRuntimeClockAuthority(fixture.runtime!)!.stepDynamics();
  const runtime = fixture.runtime!;
  const before = {
    decision: fixture.decisionRegistry.snapshot(), journal: runtimeActionJournalSnapshot(runtime),
    request: runtimeRequestLedgerSnapshot(runtime), audit: fixture.readLedger.read("principal-red", {}),
    page: runtime.ledger(redContext(fixture.red.token), resultRequest), calls: fixture.dynamicsCalls(),
    nextTick: fixture.dynamics.nextTick, pending: structuredClone(fixture.dynamics.snapshot().pending_actions),
    hostPage: runtimeActionResultLedger(runtime)!.read("principal-red", resultRequest),
  };
  const unchanged = () => {
    assert.deepEqual(runtime.ledger(redContext(fixture.red.token), resultRequest), before.page);
    assert.deepEqual(fixture.decisionRegistry.snapshot(), before.decision);
    assert.deepEqual(runtimeActionJournalSnapshot(runtime), before.journal);
    assert.deepEqual(runtimeRequestLedgerSnapshot(runtime), before.request);
    assert.deepEqual(fixture.readLedger.read("principal-red", {}), before.audit);
    assert.equal(fixture.dynamicsCalls(), before.calls);
    assert.equal(fixture.dynamics.nextTick, before.nextTick);
    assert.deepEqual(fixture.dynamics.snapshot().pending_actions, before.pending);
    assert.deepEqual(runtimeActionResultLedger(runtime)!.read("principal-red", resultRequest), before.hostPage);
    assert.equal(runtimeActionResultLedger(runtime)!.read("principal-red", resultRequest).results.length, before.hostPage.results.length);
  };
  unchanged(); unchanged();
  const foreign = runtimeFixtureWithHooks({ step: stepForActions }, true, { runId: "run-foreign", worldInstanceId: "instance-foreign" });
  denied(() => foreign.runtime!.ledger(redContext(fixture.red.token), { ...resultRequest, result_after: before.page.next_result_after! }), [fixture.red.token]);
  unchanged();
  let targetEntropy = 41;
  const target = runtimeFixtureWithHooks({ step: stepForActions, randomBytes: () => new Uint8Array(32).fill(targetEntropy++) }, true, { runId: "run-target", worldInstanceId: "instance-target" });
  assert.equal(queue(target, target.red.token, "target-result").disposition, "queued");
  readWorldRuntimeClockAuthority(target.runtime!)!.stepDynamics();
  const targetBefore = {
    decision: target.decisionRegistry.snapshot(), journal: runtimeActionJournalSnapshot(target.runtime!),
    request: runtimeRequestLedgerSnapshot(target.runtime!), audit: target.readLedger.read("principal-red", {}),
    dynamics: target.dynamics.nextTick, pending: structuredClone(target.dynamics.snapshot().pending_actions),
    page: runtimeActionResultLedger(target.runtime!)!.read("principal-red", resultRequest),
  };
  denied(() => target.runtime!.ledger(redContext(target.red.token), { ...resultRequest, result_after: before.page.next_result_after! }), [target.red.token]);
  assert.deepEqual(target.decisionRegistry.snapshot(), targetBefore.decision);
  assert.deepEqual(runtimeActionJournalSnapshot(target.runtime!), targetBefore.journal);
  assert.deepEqual(runtimeRequestLedgerSnapshot(target.runtime!), targetBefore.request);
  assert.deepEqual(target.readLedger.read("principal-red", {}), targetBefore.audit);
  assert.equal(target.dynamics.nextTick, targetBefore.dynamics);
  assert.deepEqual(target.dynamics.snapshot().pending_actions, targetBefore.pending);
  assert.deepEqual(runtimeActionResultLedger(target.runtime!)!.read("principal-red", resultRequest), targetBefore.page);
});

test("public result cursors continue only for their issued principal and reject hostile descriptor inputs", () => {
  const fixture = runtimeFixtureWithHooks({ step: stepForActions }, true, { runId: "run-1", worldInstanceId: "instance-1", decisionValidThroughTick: 4 });
  const runtime = fixture.runtime!;
  assert.equal(queue(fixture, fixture.red.token, "cursor-one").disposition, "queued");
  const clock = readWorldRuntimeClockAuthority(runtime)!; clock.stepDynamics();
  const first = runtime.ledger(redContext(fixture.red.token), { ...resultRequest, limit: 1 });
  const secondToken = fixture.decisionRegistry.mint({ principal: "principal-red", issuedTick: 1, validThroughTick: 3 });
  assert.equal(queue(fixture, secondToken.token, "cursor-two").disposition, "queued"); clock.stepDynamics();
  const second = runtime.ledger(redContext(fixture.red.token), { ...resultRequest, limit: 1, result_after: first.next_result_after });
  assert.equal(second.results[0]!.receipt_id, "world-act-2");
  const tail = runtime.ledger(redContext(fixture.red.token), { ...resultRequest, limit: 1, result_after: second.next_result_after });
  assert.deepEqual(tail.results, []); assert.deepEqual(tail.next_result_after, second.next_result_after);
  denied(() => runtime.ledger(redContext(fixture.red.token), { after: first.next_result_after }), [fixture.red.token]);
  denied(() => runtime.ledger(redContext(fixture.red.token), { ...resultRequest, result_after: 1 }), [fixture.red.token]);
  const blueToken = fixture.blue;
  assert.equal(queue(fixture, blueToken.token, "cursor-blue", "principal-blue").disposition, "queued"); clock.stepDynamics();
  const blue = runtime.ledger(blueContext(blueToken.token), resultRequest);
  denied(() => runtime.ledger(blueContext(blueToken.token), { ...resultRequest, result_after: first.next_result_after }), [blueToken.token]);
  denied(() => runtime.ledger(redContext(secondToken.token), { ...resultRequest, result_after: blue.next_result_after }), [secondToken.token]);
  let traps = 0;
  const accessor: Record<string, unknown> = { version: resultRequest.version };
  Object.defineProperty(accessor, "limit", { enumerable: true, get: () => { traps += 1; return 1; } });
  const nested: Record<string, unknown> = { ...first.next_result_after! };
  Object.defineProperty(nested, "proof", { enumerable: true, get: () => { traps += 1; return "0".repeat(64); } });
  const proxy = new Proxy({ ...resultRequest }, { get: () => { traps += 1; throw new Error("trap"); } });
  const nestedProxy = new Proxy({ ...first.next_result_after! }, { get: () => { traps += 1; throw new Error("trap"); } });
  for (const request of [accessor, { ...resultRequest, extra: true }, proxy, { ...resultRequest, result_after: nested }, { ...resultRequest, result_after: nestedProxy }]) denied(() => runtime.ledger(redContext(secondToken.token), request), [secondToken.token]);
  assert.equal(traps, 0);
  const legacyActive = fixture.decisionRegistry.mint({ principal: "principal-red", issuedTick: 3, validThroughTick: 4 });
  const legacyPage = runtime.ledger(redContext(legacyActive.token), { limit: 100 });
  assert.ok(legacyPage.next_after > 0);
  const legacyContinuation = runtime.ledger(redContext(legacyActive.token), { after: legacyPage.next_after, limit: 100 });
  assert.equal(legacyContinuation.identity.manifest_digest, legacyPage.identity.manifest_digest);
  assert.equal(legacyContinuation.records.at(-1)?.operation, "ledger");
  assert.equal(legacyContinuation.next_after, legacyContinuation.records.at(-1)?.sequence);
  const consumed = runtime.ledger(redContext(secondToken.token), resultRequest);
  assert.ok(consumed.next_result_after);
  denied(() => runtime.ledger(redContext(secondToken.token), { ...resultRequest, result_after: legacyPage.next_after }), [secondToken.token]);
  const schemaFixture = runtimeFixtureWithHooks({});
  denied(() => schemaFixture.runtime!.ledger(redContext(schemaFixture.red.token), { after: consumed.next_result_after, limit: 100 }), [schemaFixture.red.token]);
  // C2 covers only stale/evicted cursor frontiers in actionResultLedger.test.ts
  // "uses principal paging sequences and fails only after an unseen same-principal eviction".
});

test("public red and blue result pages isolate identities while legitimately sharing one effect", () => {
  const fixture = runtimeFixtureWithHooks({ step: (input) => {
    const actions = (input as { readonly actions: readonly { readonly sequence: number }[] }).actions;
    return { tick: 0, events: [{ cause_action_sequences: actions.map((action) => action.sequence), kind: "impact", payload: { strength: 1 }, source: "system:test", target: "object:ball" }], action_results: actions.map(({ sequence }) => ({ accepted: true, sequence })) };
  } });
  assert.equal(queue(fixture, fixture.red.token, "shared-red").disposition, "queued");
  assert.equal(queue(fixture, fixture.blue.token, "shared-blue", "principal-blue").disposition, "queued");
  readWorldRuntimeClockAuthority(fixture.runtime!)!.stepDynamics();
  const red = fixture.runtime!.ledger(redContext(fixture.red.token), resultRequest);
  const blue = fixture.runtime!.ledger(blueContext(fixture.blue.token), resultRequest);
  assert.deepEqual(red.results.map((result) => [result.receipt_id, result.decision_id, result.result_id, result.action_sequence]), [["world-act-1", "decision-000000000001", "world-result-1", 1]]);
  assert.deepEqual(blue.results.map((result) => [result.receipt_id, result.decision_id, result.result_id, result.action_sequence]), [["world-act-2", "decision-000000000002", "world-result-2", 2]]);
  const redResult = red.results[0]!, blueResult = blue.results[0]!;
  assert.deepEqual(runtimeActionJournalSnapshot(fixture.runtime!)!.cells.map((cell) => cell.record.principal), ["principal-red", "principal-blue"]);
  assert.equal(redResult.actor, "world://pitch/entity/red"); assert.equal(blueResult.actor, "world://pitch/entity/blue");
  assert.deepEqual(redResult.identity, { run_id: "run-1", world_id: "pitch", world_instance_id: "instance-1", manifest_digest: redResult.identity.manifest_digest, state_version: 1 });
  assert.deepEqual(blueResult.identity, { run_id: "run-1", world_id: "pitch", world_instance_id: "instance-1", manifest_digest: blueResult.identity.manifest_digest, state_version: 1 });
  assert.deepEqual((redResult as Extract<typeof redResult, { status: "applied" }>).caused_effect_ids, ["world-effect-1"]);
  assert.deepEqual((blueResult as Extract<typeof blueResult, { status: "applied" }>).caused_effect_ids, ["world-effect-1"]);
  assert.deepEqual(red.results.map((result) => result.receipt_id), ["world-act-1"]);
  assert.deepEqual(blue.results.map((result) => result.receipt_id), ["world-act-2"]);
  denied(() => fixture.runtime!.ledger(redContext(fixture.red.token), { ...resultRequest, result_after: blue.next_result_after }), [fixture.red.token]);
});

test("public rejected results omit effects and result reads cannot reenter or mutate legacy state", () => {
  let reentry: unknown;
  const reentrant = runtimeFixtureWithHooks({
    lower: () => { try { reentry = reentrant.runtime!.ledger(redContext(reentrant.red.token), resultRequest); } catch (error) { reentry = error; } return { force: 1 }; },
  });
  assert.deepEqual(queue(reentrant, reentrant.red.token, "reentry-denied"), ingressDenied("ingress_reentered"));
  assert.ok(reentry instanceof WorldRuntimeError && reentry.code === "world_runtime_denied");
  assert.equal(runtimeActionJournalSnapshot(reentrant.runtime!)!.cells.length, 0);
  assert.equal(runtimeActionResultLedger(reentrant.runtime!)!.read("principal-red", resultRequest).results.length, 0);

  const fixture = runtimeFixtureWithHooks({
    step: (input) => ({ tick: 0, events: [], action_results: (input as { readonly actions: readonly { readonly sequence: number }[] }).actions.map(({ sequence }) => ({ accepted: false, code: "blocked", sequence })) }),
  });
  const before = { audit: fixture.readLedger.read("principal-red", {}), request: runtimeRequestLedgerSnapshot(fixture.runtime!), journal: runtimeActionJournalSnapshot(fixture.runtime!), decision: fixture.decisionRegistry.snapshot() };
  assert.equal(queue(fixture, fixture.red.token, "rejected-reentry").disposition, "queued");
  assert.ok(reentry instanceof WorldRuntimeError && reentry.code === "world_runtime_denied");
  readWorldRuntimeClockAuthority(fixture.runtime!)!.stepDynamics();
  const page = fixture.runtime!.ledger(redContext(fixture.red.token), resultRequest);
  assert.equal(page.results[0]!.status, "rejected_at_mechanics");
  if (page.results[0]!.status === "rejected_at_mechanics") assert.equal(page.results[0]!.rejection_code, "blocked");
  assert.equal("caused_effect_ids" in page.results[0]!, false);
  const afterAct = { audit: fixture.readLedger.read("principal-red", {}), request: runtimeRequestLedgerSnapshot(fixture.runtime!), journal: runtimeActionJournalSnapshot(fixture.runtime!), decision: fixture.decisionRegistry.snapshot(), calls: fixture.dynamicsCalls() };
  assert.deepEqual(fixture.runtime!.ledger(redContext(fixture.red.token), resultRequest), page);
  assert.deepEqual({ audit: fixture.readLedger.read("principal-red", {}), request: runtimeRequestLedgerSnapshot(fixture.runtime!), journal: runtimeActionJournalSnapshot(fixture.runtime!), decision: fixture.decisionRegistry.snapshot(), calls: fixture.dynamicsCalls() }, afterAct);
  assert.notDeepEqual(afterAct.request, before.request);
  // Complete malformed/foreign/duplicate/missing terminal matrices remain in
  // actionResults.test.ts "closes every impossible join with authorized pending evidence and no terminal facts"
  // and worldActionMechanicsRealSession.test.ts "real result-mode checked validation...".
});

test("public undeclared provider rejection is fixed and secret-free", () => {
  const fixture = runtimeFixtureWithHooks({ step: (input) => ({
    tick: 0, events: [], action_results: (input as { readonly actions: readonly { readonly sequence: number }[] }).actions.map(({ sequence }) => ({ accepted: false, code: "provider-secret", sequence })),
  }) });
  const receipt = queue(fixture, fixture.red.token, "undeclared-provider-rejection");
  if (receipt.disposition !== "queued") throw new Error("expected queued receipt");
  assert.equal(readWorldRuntimeClockAuthority(fixture.runtime!)!.stepDynamics().action_results, 1);
  const page = fixture.runtime!.ledger(redContext(fixture.red.token), resultRequest);
  assert.equal(page.results.length, 1);
  const result = page.results[0]!;
  assert.equal(result.status, "rejected_at_mechanics");
  if (result.status === "rejected_at_mechanics") assert.equal(result.rejection_code, "world_action_rejected");
  assert.equal("caused_effect_ids" in result, false);
  assert.equal(JSON.stringify(page).includes("provider-secret"), false);
  assert.deepEqual(runtimeActionJournalSnapshot(fixture.runtime!)!.cells[0]!.terminal, {
    disposition: "rejected_at_mechanics", receipt_id: receipt.receipt_id, decision_id: receipt.decision_id,
    sequence: 1, apply_tick: 0, projection: "not_configured", public_code: "world_action_rejected",
  });
});

test("public malformed terminal join fails closed after real act and forbids retry", () => {
  const fixture = runtimeFixtureWithHooks({ step: (input) => ({
    tick: 0, events: [], action_results: [{ accepted: true, sequence: (input as { readonly actions: readonly { readonly sequence: number }[] }).actions[0]!.sequence + 1 }],
  }) });
  const originalEnvelope = runtimeActEnvelope("malformed-public-join", { affordance: "world://pitch/affordance/kick", target: "world://pitch/entity/ball", input: { force: 1 } });
  const receipt = fixture.runtime!.act(redContext(fixture.red.token), originalEnvelope);
  if (receipt.disposition !== "queued") throw new Error("expected queued receipt");
  const clock = readWorldRuntimeClockAuthority(fixture.runtime!)!;
  assert.throws(() => clock.stepDynamics());
  assert.equal(fixture.dynamics.nextTick, 0);
  assert.equal(fixture.dynamics.snapshot().pending_actions.length, 1);
  assert.deepEqual(fixture.runtime!.ledger(redContext(fixture.red.token), resultRequest).results, []);
  assert.deepEqual(runtimeActionResultLedger(fixture.runtime!)!.read("principal-red", resultRequest).results, []);
  assert.equal(runtimeActionJournalStatus(fixture.runtime!)!.closed, true);
  assert.equal(runtimeRequestLedgerSnapshot(fixture.runtime!)!.closed, true);
  assert.deepEqual(runtimeActionJournalSnapshot(fixture.runtime!)!.cells.map((cell) => [cell.receipt.receipt_id, cell.state, cell.terminal]), [[receipt.receipt_id, "authorized", null]]);
  assert.equal(readWorldActionResultLedger(runtimeActionResultLedger(fixture.runtime!)!)!.hasLiveReservation(), false);
  assert.throws(() => clock.stepDynamics());
  assert.deepEqual(queue(fixture, fixture.red.token, "malformed-public-retry"), ingressDenied("ingress_closed"));
  const beforeReplay = {
    dynamics: fixture.dynamics.snapshot(), journal: runtimeActionJournalSnapshot(fixture.runtime!), request: runtimeRequestLedgerSnapshot(fixture.runtime!),
    page: fixture.runtime!.ledger(redContext(fixture.red.token), resultRequest), results: runtimeActionResultLedger(fixture.runtime!)!.read("principal-red", resultRequest), calls: fixture.dynamicsCalls(),
  };
  assert.deepEqual(fixture.runtime!.act(redContext(fixture.red.token), originalEnvelope), receipt);
  assert.deepEqual(fixture.dynamics.snapshot(), beforeReplay.dynamics);
  assert.deepEqual(runtimeActionJournalSnapshot(fixture.runtime!), beforeReplay.journal);
  assert.deepEqual(runtimeRequestLedgerSnapshot(fixture.runtime!), beforeReplay.request);
  assert.deepEqual(fixture.runtime!.ledger(redContext(fixture.red.token), resultRequest), beforeReplay.page);
  assert.deepEqual(runtimeActionResultLedger(fixture.runtime!)!.read("principal-red", resultRequest), beforeReplay.results);
  assert.equal(fixture.dynamicsCalls(), beforeReplay.calls);
});
