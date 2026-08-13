import assert from "node:assert/strict";
import test from "node:test";
import { actWorldRuntime, denyWith } from "./act.js";
import { createWorldActionJournal, type WorldActionJournal } from "./actionJournal.js";
import { readWorldRuntimeClockAuthority } from "./clockAuthority.js";
import { DYNAMICS_LIMITS } from "../dynamics/limits.js";
import { createWorldRequestLedger } from "./requestLedger.js";
import { runtimeActionJournalSnapshot, runtimeActionJournalStatus, runtimeActEnvelope, runtimeFixtureWithHooks, runtimeRequestLedgerSnapshot } from "./runtime.test-helper.js";
import type { WorldActIngressRejectionReason } from "./actTypes.js";
const request = Object.freeze({
  affordance: "world://pitch/affordance/kick",
  target: "world://pitch/entity/ball",
  input: { force: 1 },
});
const context = (principal: string, token: string) => ({ principal, decisionToken: token });
const denied = (reason: WorldActIngressRejectionReason, fieldPath?: string) => Object.freeze({
  disposition: "rejected_at_ingress" as const, code: "world_action_denied" as const, reason,
  ...(fieldPath === undefined ? {} : { field_path: fieldPath }),
});
test("resolved actions replay one frozen receipt without repeating runtime effects", () => {
  let observations = 0;
  const fixture = runtimeFixtureWithHooks({
    observe: (input) => {
      observations += 1;
      return { channels: (input as { sense_addresses: readonly string[] }).sense_addresses.map((sense_address) => ({
        components: { x: 1 }, sense_address, subject_address: "object:red",
      })) };
    },
    step: (input) => {
      const action = (input as { actions: readonly { sequence: number }[] }).actions[0]!;
      return { tick: 0, events: [], action_results: [{ accepted: true, sequence: action.sequence }] };
    },
  });
  const bytes = runtimeActEnvelope("idempotent-action", request);
  const first = fixture.runtime!.act(context("principal-red", fixture.red.token), bytes);
  assert.equal(first.disposition, "queued");
  const observationsAfterFirst = observations;
  const admittedJournal = runtimeActionJournalSnapshot(fixture.runtime!)!;
  assert.deepEqual(admittedJournal.audits, [{ principal: "principal-red", result: "queued" }]);
  assert.equal(admittedJournal.cells.length, 1);
  assert.equal(admittedJournal.cells[0]!.state, "authorized");
  assert.equal(runtimeRequestLedgerSnapshot(fixture.runtime!)!.record_count, 1);
  assert.equal(fixture.dynamics.snapshot().pending_actions.length, 1);
  assert.deepEqual(readWorldRuntimeClockAuthority(fixture.runtime!)!.stepDynamics(), { tick: 0, action_results: 1, events: 0 });
  const retried = fixture.runtime!.act(context("principal-red", fixture.red.token), bytes);
  assert.deepEqual(retried, first);
  assert.equal(observations, observationsAfterFirst);
  const journal = runtimeActionJournalSnapshot(fixture.runtime!)!;
  assert.equal(journal.audits.length, 1);
  assert.equal(journal.cells.length, 1);
  assert.equal(journal.cells[0]!.state, "terminal");
  const ledger = runtimeRequestLedgerSnapshot(fixture.runtime!)!;
  assert.equal(ledger.record_count, 1);
  assert.equal(ledger.records[0]!.receipt.receipt_id, first.receipt_id);
});
test("caller byte mutation cannot alter the retained request identity", () => {
  const fixture = runtimeFixtureWithHooks({});
  const bytes = runtimeActEnvelope("byte-isolation", request);
  const original = Uint8Array.from(bytes);
  const first = fixture.runtime!.act(context("principal-red", fixture.red.token), bytes);
  assert.equal(first.disposition, "queued");
  bytes[0] ^= 1;
  assert.deepEqual(fixture.runtime!.act(context("principal-red", fixture.red.token), bytes), denied("request_malformed"));
  assert.deepEqual(fixture.runtime!.act(context("principal-red", fixture.red.token), original), first);
  assert.equal(runtimeRequestLedgerSnapshot(fixture.runtime!)!.record_count, 1);
});
test("changed canonical content and principal conflict under one request id", () => {
  const fixture = runtimeFixtureWithHooks({});
  const bytes = runtimeActEnvelope("identity-bound", request);
  const first = fixture.runtime!.act(context("principal-red", fixture.red.token), bytes);
  assert.equal(first.disposition, "queued");
  assert.deepEqual(fixture.runtime!.act(context("principal-red", fixture.red.token), runtimeActEnvelope("identity-bound", { ...request, input: { force: 2 } })), denied("request_conflict"));
  assert.deepEqual(fixture.runtime!.act(context("principal-blue", fixture.blue.token), bytes), denied("request_conflict"));
  const journal = runtimeActionJournalSnapshot(fixture.runtime!)!;
  assert.deepEqual(journal.audits, [
    { principal: "principal-blue", result: "denied" },
    { principal: "principal-red", result: "denied" },
    { principal: "principal-red", result: "queued" },
  ]);
  assert.equal(runtimeRequestLedgerSnapshot(fixture.runtime!)!.record_count, 1);
  assert.equal(journal.cells.length, 1);
});
test("queued audit failure rolls back every prepared authority after the real queue", () => {
  let observed = 0;
  let available = 0;
  let lowered = 0;
  const fixture = runtimeFixtureWithHooks({
    observe: (input) => { observed += 1; return { channels: (input as { sense_addresses: readonly string[] }).sense_addresses.map((sense_address) => ({ components: { x: 1 }, sense_address, subject_address: "object:red" })) }; },
    available: () => { available += 1; return true; },
    lower: () => { lowered += 1; return { force: 1 }; },
  }, false);
  const journal = createWorldActionJournal(); journal.reservePrincipals(["principal-red"]);
  let queuedFailure = true; let deniedAudits = 0; let cellPrepared = false; let queueReached = false;
  const failingJournal: WorldActionJournal = {
    reservePrincipals: (principals) => journal.reservePrincipals(principals),
    reserveAudit: (principal) => {
      const reservation = journal.reserveAudit(principal);
      return Object.freeze({ terminal_capacity: reservation.terminal_capacity, commit: (result: "queued" | "denied") => {
        if (result === "queued" && queuedFailure) {
          queuedFailure = false; queueReached = fixture.dynamics.snapshot().pending_actions.length === 1;
          throw new Error("forced queued audit failure");
        }
        reservation.commit(result); if (result === "denied") deniedAudits += 1;
      } });
    },
    audit: (principal, result) => journal.audit(principal, result),
    reserve: (receipt, sequence) => {
      const reservation = journal.reserve(receipt, sequence);
      return Object.freeze({
        persist: (record: Parameters<typeof reservation.persist>[0]) => reservation.persist(record),
        prepareAuthorization: () => { cellPrepared = true; reservation.prepareAuthorization(); },
        authorize: () => reservation.authorize(), abort: () => reservation.abort(),
      });
    },
    pending: (tick) => journal.pending(tick), reserveTerminals: (tick) => journal.reserveTerminals(tick),
    terminal: (record) => journal.terminal(record), project: (record) => journal.project(record),
    close: () => journal.close(), snapshot: () => journal.snapshot(), restore: (input) => journal.restore(input),
  };
  const ledger = createWorldRequestLedger({ max_records: 9_999 });
  let requestPrepared = false;
  const realBegin = ledger.beginClaim.bind(ledger);
  const requestLedger = { ...ledger, beginClaim: (input: unknown) => {
    const claim = realBegin(input);
    if (claim.kind !== "new") return claim;
    return { ...claim, reservation: { ...claim.reservation, prepare: (preparation: Parameters<typeof claim.reservation.prepare>[0]) => { requestPrepared = true; claim.reservation.prepare(preparation); } } };
  } };
  const beforeDynamics = fixture.dynamics.snapshot();
  const beforeDecision = fixture.decisionRegistry.inspect();
  const receipt = actWorldRuntime({
    dynamics: fixture.dynamics, surfaceRegistry: fixture.surfaceRegistry, decisionRegistry: fixture.decisionRegistry,
    journal: failingJournal, requestLedger, runId: "run-1", worldId: "pitch", worldInstanceId: "instance-1", closeMechanics: () => {}, refuse: denyWith,
  }, fixture.capabilityManifests.find((item) => item.manifest.holder.principal === "principal-red")!.manifest,
  "principal-red", fixture.red.token, runtimeActEnvelope("forced-queued-audit", request), () => false);
  assert.deepEqual(receipt, denied("internal_error"));
  assert.equal(requestPrepared, true); assert.equal(cellPrepared, true); assert.equal(queueReached, true);
  assert.equal(fixture.decisionRegistry.inspect().decisions.at(-1)?.status, "active");
  assert.deepEqual(fixture.dynamics.snapshot(), beforeDynamics);
  assert.deepEqual(fixture.decisionRegistry.inspect(), beforeDecision);
  assert.deepEqual(ledger.snapshot().record_count, 0);
  assert.deepEqual(journal.snapshot().cells, []);
  assert.equal(deniedAudits, 1);
  assert.equal(observed, 2);
  assert.equal(available, 1);
  assert.equal(lowered, 1);
  assert.equal(fixture.dynamics.snapshot().pending_actions.length, 0);
  assert.equal(journal.snapshot().audits.length, 1);
  const retry = actWorldRuntime({ dynamics: fixture.dynamics, surfaceRegistry: fixture.surfaceRegistry, decisionRegistry: fixture.decisionRegistry,
    journal: failingJournal, requestLedger, runId: "run-1", worldId: "pitch", worldInstanceId: "instance-1", closeMechanics: () => {}, refuse: denyWith },
    fixture.capabilityManifests.find((item) => item.manifest.holder.principal === "principal-red")!.manifest,
    "principal-red", fixture.red.token, runtimeActEnvelope("forced-queued-audit", request), () => false);
  assert.equal(retry.disposition, "queued");
});
test("accepted-only permanent frontier closes all authorities on the final denial", () => {
  let observed = 0; let available = 0; let lowered = 0; let projected = 0; let queued = 0;
  let tokenState = 1;
  const randomBytes = (): Uint8Array => {
    const bytes = new Uint8Array(32);
    let state = tokenState++;
    for (let index = 0; index < bytes.length; index += 1) {
      state = Math.imul(state ^ (state >>> 16), 2_246_822_519);
      state = Math.imul(state ^ (state >>> 13), 3_266_489_917);
      bytes[index] = state & 0xff;
    }
    return bytes;
  };
  const fixture = runtimeFixtureWithHooks({
    observe: (input) => { observed += 1; return { channels: (input as { sense_addresses: readonly string[] }).sense_addresses.map((sense_address) => ({ components: { x: 1 }, sense_address, subject_address: "object:red" })) }; },
    available: () => { available += 1; return true; }, lower: () => { lowered += 1; return { force: 1 }; },
    project: () => { projected += 1; return { channels: [{ components: { x: 1 }, sense_address: "sense:vision", subject_address: "entity:red" }] }; },
    projectDetail: () => { projected += 1; return { channels: [{ components: { x: 1 }, sense_address: "sense:red-detail", subject_address: "entity:red" }] }; },
    randomBytes,
    step: (input) => { queued += (input as { actions: readonly unknown[] }).actions.length; return { tick: (input as { tick: number }).tick, events: [], action_results: (input as { actions: readonly { sequence: number }[] }).actions.map(({ sequence }) => ({ accepted: true, sequence })) }; },
  });
  let accepted = 0; let token = fixture.red.token;
  let firstBytes: Uint8Array | undefined;
  let firstReceipt: ReturnType<NonNullable<typeof fixture.runtime>["act"]> | undefined;
  let beforeFinal: { observed: number; available: number; lowered: number; projected: number; queued: number; dynamics: ReturnType<typeof fixture.dynamics.snapshot>; decision: ReturnType<typeof fixture.decisionRegistry.inspect> } | undefined;
  let final: ReturnType<NonNullable<typeof fixture.runtime>["act"]> | undefined;
  for (; accepted < DYNAMICS_LIMITS.retained_action_records; accepted += 1) {
    const tick = fixture.dynamics.nextTick;
    beforeFinal = { observed, available, lowered, projected, queued, dynamics: fixture.dynamics.snapshot(), decision: fixture.decisionRegistry.inspect() };
    const bytes = runtimeActEnvelope(`accepted-capacity-${accepted}`, request);
    const result = fixture.runtime!.act(context("principal-red", token), bytes);
    if (result.disposition === "rejected_at_ingress") { final = result; break; }
    assert.equal(result.disposition, "queued");
    if (accepted === 0) { firstBytes = Uint8Array.from(bytes); firstReceipt = result; }
    readWorldRuntimeClockAuthority(fixture.runtime!)!.stepDynamics();
    token = fixture.decisionRegistry.mint({ principal: "principal-red", issuedTick: fixture.dynamics.nextTick, validThroughTick: 20_000 }).token;
  }
  assert.ok(final !== undefined, "retained-record denial was not discovered below the shared bound");
  assert.deepEqual(final, denied("capacity_exhausted")); assert.ok(accepted > 0); assert.ok(accepted < DYNAMICS_LIMITS.retained_action_records);
  const before = beforeFinal!;
  assert.equal(observed, before.observed + 2, "observe delta");
  assert.equal(available, before.available + 1, "available delta");
  assert.equal(lowered, before.lowered + 1, "lower delta");
  assert.equal(projected, before.projected + 2, "project delta");
  assert.equal(queued, before.queued, "step delta");
  assert.deepEqual(fixture.dynamics.snapshot(), before.dynamics); assert.deepEqual(fixture.decisionRegistry.inspect(), before.decision);
  const ledger = runtimeRequestLedgerSnapshot(fixture.runtime!)!;
  assert.equal(ledger.closed, true); assert.equal(ledger.record_count, accepted);
  assert.equal(fixture.dynamics.snapshot().pending_actions.length, 0);
  assert.deepEqual(runtimeActionJournalStatus(fixture.runtime!), { closed: true, audit_count: accepted + 1, cell_count: accepted });
  // Every preceding audit is accepted; the single extra status count is the final denial.
  assert.throws(() => readWorldRuntimeClockAuthority(fixture.runtime!)!.stepDynamics(), /closed/u);
  assert.ok(firstBytes !== undefined); assert.ok(firstReceipt !== undefined); assert.ok(Object.isFrozen(firstReceipt));
  const replayBefore = { journal: runtimeActionJournalStatus(fixture.runtime!), ledger: runtimeRequestLedgerSnapshot(fixture.runtime!), dynamics: fixture.dynamics.snapshot(), decision: fixture.decisionRegistry.inspect(), observed, available, lowered, projected, queued };
  assert.deepEqual(fixture.runtime!.act(context("principal-red", "unusable-token"), firstBytes), firstReceipt);
  assert.deepEqual(runtimeActionJournalStatus(fixture.runtime!), replayBefore.journal);
  assert.deepEqual(runtimeRequestLedgerSnapshot(fixture.runtime!), replayBefore.ledger);
  assert.deepEqual(fixture.dynamics.snapshot(), replayBefore.dynamics);
  assert.deepEqual(fixture.decisionRegistry.inspect(), replayBefore.decision);
  assert.deepEqual({ observed, available, lowered, projected, queued }, { observed: replayBefore.observed, available: replayBefore.available, lowered: replayBefore.lowered, projected: replayBefore.projected, queued: replayBefore.queued });
});
test("final audit slot denies before consuming a real decision", () => {
  let observed = 0; let available = 0; let lowered = 0; let projected = 0; let queued = 0;
  const fixture = runtimeFixtureWithHooks({
    observe: (input) => { observed += 1; return { channels: (input as { sense_addresses: readonly string[] }).sense_addresses.map((sense_address) => ({ components: { x: 1 }, sense_address, subject_address: "object:red" })) }; },
    available: () => { available += 1; return true; }, lower: () => { lowered += 1; return { force: 1 }; },
    project: () => { projected += 1; return { channels: [] }; },
    step: (input) => { queued += (input as { actions: readonly unknown[] }).actions.length; return { tick: (input as { tick: number }).tick, events: [], action_results: [] }; },
  });
  for (let index = 0; index < 9_999; index += 1) {
    assert.deepEqual(fixture.runtime!.act(context("principal-red", "unusable-token"), runtimeActEnvelope(`audit-fill-${index}`, request)), denied("decision_token_invalid"));
  }
  const before = {
    dynamics: fixture.dynamics.snapshot(), status: runtimeActionJournalStatus(fixture.runtime!),
    ledger: runtimeRequestLedgerSnapshot(fixture.runtime!), calls: fixture.dynamicsCalls(),
    observed, available, lowered, projected, queued,
  };
  const decisionBefore = fixture.decisionRegistry.inspect();
  assert.deepEqual(fixture.runtime!.act(context("principal-red", fixture.red.token), runtimeActEnvelope("audit-final", request)), denied("capacity_exhausted"));
  assert.deepEqual(fixture.dynamics.snapshot(), before.dynamics);
  assert.deepEqual(fixture.decisionRegistry.inspect(), decisionBefore);
  assert.deepEqual(runtimeActionJournalStatus(fixture.runtime!), { closed: true, audit_count: 10_000, cell_count: 0 });
  assert.deepEqual(runtimeRequestLedgerSnapshot(fixture.runtime!), { version: "simfile.world-request-ledger.v1", closed: true, record_count: 0, code_units: 0, records: [] });
  assert.equal(fixture.dynamicsCalls(), before.calls); assert.equal(observed, before.observed);
  assert.equal(available, before.available); assert.equal(lowered, before.lowered);
  assert.equal(projected, before.projected); assert.equal(queued, before.queued);
  assert.equal(fixture.dynamics.snapshot().pending_actions.length, 0);
  assert.throws(() => readWorldRuntimeClockAuthority(fixture.runtime!)!.stepDynamics(), /closed/u);
});
test("nested act denial settles the outer audit and closes every authority", () => {
  let runtime: NonNullable<ReturnType<typeof runtimeFixtureWithHooks>["runtime"]>;
  let nested: ReturnType<NonNullable<typeof runtime>["act"]> | undefined;
  let callbacks = 0;
  const fixture = runtimeFixtureWithHooks({
    observe: () => {
      callbacks += 1;
      if (nested === undefined) nested = runtime!.act(context("principal-red", fixture.red.token), runtimeActEnvelope("nested-reentry", request));
      return { channels: [] };
    },
  });
  runtime = fixture.runtime!;
  for (let index = 0; index < 9_998; index += 1) {
    assert.deepEqual(runtime.act(context("principal-red", "unusable-token"), runtimeActEnvelope(`nested-fill-${index}`, request)), denied("decision_token_invalid"));
  }
  const beforeDynamics = fixture.dynamics.snapshot();
  const beforeDecision = fixture.decisionRegistry.inspect();
  const outer = runtime.act(context("principal-red", fixture.red.token), runtimeActEnvelope("outer-reentry", request));
  assert.deepEqual(outer, denied("ingress_reentered")); assert.deepEqual(nested, denied("ingress_reentered"));
  assert.equal(callbacks, 2);
  assert.deepEqual(runtimeActionJournalStatus(runtime), { closed: true, audit_count: 10_000, cell_count: 0 });
  assert.deepEqual(runtimeRequestLedgerSnapshot(runtime), { version: "simfile.world-request-ledger.v1", closed: true, record_count: 0, code_units: 0, records: [] });
  assert.deepEqual(fixture.dynamics.snapshot(), beforeDynamics);
  assert.deepEqual(fixture.decisionRegistry.inspect(), beforeDecision);
  assert.equal(fixture.dynamics.snapshot().pending_actions.length, 0);
  assert.throws(() => readWorldRuntimeClockAuthority(runtime)!.stepDynamics(), /closed/u);
});
test("terminal-slot conflict closes authorities while exact replay remains available", () => {
  let observed = 0; let available = 0; let lowered = 0; let projected = 0; let queued = 0;
  const fixture = runtimeFixtureWithHooks({
    observe: (input) => { observed += 1; return { channels: (input as { sense_addresses: readonly string[] }).sense_addresses.map((sense_address) => ({ components: { x: 1 }, sense_address, subject_address: "object:red" })) }; },
    available: () => { available += 1; return true; }, lower: () => { lowered += 1; return { force: 1 }; },
    project: () => { projected += 1; return { channels: [{ components: { x: 1 }, sense_address: "sense:vision", subject_address: "entity:red" }] }; },
    step: (input) => { queued += (input as { actions: readonly unknown[] }).actions.length; return { tick: (input as { tick: number }).tick, events: [], action_results: (input as { actions: readonly { sequence: number }[] }).actions.map(({ sequence }) => ({ accepted: true, sequence })) }; },
  });
  const original = runtimeActEnvelope("last-slot-conflict", request);
  const first = fixture.runtime!.act(context("principal-red", fixture.red.token), original);
  assert.equal(first.disposition, "queued");
  readWorldRuntimeClockAuthority(fixture.runtime!)!.stepDynamics();
  let deniedAudits = 0;
  for (let index = 0; index < 9_998; index += 1) {
    assert.deepEqual(fixture.runtime!.act(context("principal-red", fixture.red.token), runtimeActEnvelope(`terminal-fill-${index}`, request)), denied("decision_token_consumed"));
    deniedAudits += 1;
  }
  const before = { dynamics: fixture.dynamics.snapshot(), status: runtimeActionJournalStatus(fixture.runtime!), ledger: runtimeRequestLedgerSnapshot(fixture.runtime!), decision: fixture.decisionRegistry.inspect(), calls: fixture.dynamicsCalls(), observed, available, lowered, projected, queued };
  assert.deepEqual(fixture.runtime!.act(context("principal-red", fixture.red.token), runtimeActEnvelope("last-slot-conflict", { ...request, input: { force: 2 } })), denied("capacity_exhausted"));
  const ledger = runtimeRequestLedgerSnapshot(fixture.runtime!)!;
  assert.deepEqual(fixture.dynamics.snapshot(), before.dynamics); assert.deepEqual(fixture.decisionRegistry.inspect(), before.decision);
  assert.equal(fixture.dynamicsCalls(), before.calls); assert.equal(ledger.closed, true);
  assert.deepEqual({ observed, available, lowered, projected, queued }, { observed: before.observed, available: before.available, lowered: before.lowered, projected: before.projected, queued: before.queued });
  assert.equal(deniedAudits, 9_998); assert.equal(fixture.dynamics.snapshot().pending_actions.length, 0);
  assert.deepEqual(runtimeActionJournalStatus(fixture.runtime!), { closed: true, audit_count: 10_000, cell_count: 1 });
  assert.throws(() => readWorldRuntimeClockAuthority(fixture.runtime!)!.stepDynamics(), /closed/u);
  const replayBefore = { dynamics: fixture.dynamics.snapshot(), status: runtimeActionJournalStatus(fixture.runtime!), ledger: runtimeRequestLedgerSnapshot(fixture.runtime!), decision: fixture.decisionRegistry.inspect(), calls: fixture.dynamicsCalls(), observed, available, lowered, projected, queued };
  const replay = fixture.runtime!.act(context("principal-red", "wrong-token"), original);
  assert.deepEqual(replay, first); assert.ok(Object.isFrozen(replay));
  assert.deepEqual(fixture.dynamics.snapshot(), replayBefore.dynamics);
  assert.deepEqual(runtimeActionJournalStatus(fixture.runtime!), replayBefore.status);
  assert.deepEqual(runtimeRequestLedgerSnapshot(fixture.runtime!), replayBefore.ledger);
  assert.deepEqual(fixture.decisionRegistry.inspect(), replayBefore.decision);
  assert.equal(fixture.dynamicsCalls(), replayBefore.calls);
  assert.deepEqual({ observed, available, lowered, projected, queued }, { observed: replayBefore.observed, available: replayBefore.available, lowered: replayBefore.lowered, projected: replayBefore.projected, queued: replayBefore.queued });
});
test("queue failure aborts the claim and an identical request can retry", () => {
  const fixture = runtimeFixtureWithHooks({
    step: (input) => ({
      tick: 0,
      events: [],
      action_results: (input as { actions: readonly { sequence: number }[] }).actions.map(({ sequence }) => ({ accepted: true, sequence })),
    }),
  });
  for (let index = 0; index < 128; index += 1) {
    fixture.dynamics.queueAction({
      act_id: `filler-${index}`, action: "wait", actor: "object:blue", at_tick: 0,
      input: {}, origin: "agentic", principal_id: "principal-blue", target: "object:blue",
    });
  }
  const before = fixture.dynamics.snapshot();
  const bytes = runtimeActEnvelope("queue-retry", request);
  assert.deepEqual(fixture.runtime!.act(context("principal-red", fixture.red.token), bytes), denied("internal_error"));
  assert.deepEqual(fixture.dynamics.snapshot(), before);
  assert.equal(runtimeRequestLedgerSnapshot(fixture.runtime!)!.record_count, 0);
  fixture.dynamics.step();
  assert.equal(fixture.runtime!.act(context("principal-red", fixture.red.token), bytes).disposition, "queued");
});
test("a failed queue attempt never occupies the idempotency slot for its own retry", () => {
  const fixture = runtimeFixtureWithHooks({
    step: (input) => ({
      tick: (input as { tick: number }).tick,
      events: [],
      action_results: (input as { actions: readonly { sequence: number }[] }).actions.map(({ sequence }) => ({ accepted: true, sequence })),
    }),
  });
  const fill = () => {
    const at_tick = fixture.dynamics.nextTick;
    for (let index = 0; index < DYNAMICS_LIMITS.actions_per_tick; index += 1) {
      fixture.dynamics.queueAction({
        act_id: `filler-${at_tick}-${index}`, action: "wait", actor: "object:blue", at_tick,
        input: {}, origin: "agentic", principal_id: "principal-blue", target: "object:blue",
      });
    }
  };
  fill();
  const before = fixture.dynamics.snapshot();
  const bytes = runtimeActEnvelope("retry-after-queue-failure", request);
  assert.deepEqual(fixture.runtime!.act(context("principal-red", fixture.red.token), bytes), denied("internal_error"));
  // The failed attempt claimed nothing: no dynamics mutation, no ledger record,
  // and ingress stays open, so the identical request is still retryable.
  assert.deepEqual(fixture.dynamics.snapshot(), before);
  assert.equal(runtimeRequestLedgerSnapshot(fixture.runtime!)!.record_count, 0);
  assert.equal(runtimeActionJournalStatus(fixture.runtime!)!.closed, false);
  // A second saturated tick pushes lifetime ingress past the per-tick retention
  // bound: the retry is only admitted if no live ingress structure accumulates
  // across ticks, i.e. the bound stays per-tick instead of capping the session.
  fixture.dynamics.step();
  fill();
  fixture.dynamics.step();
  assert.ok(fixture.dynamics.snapshot().next_action_sequence > DYNAMICS_LIMITS.actions_per_tick * 2);
  const retry = fixture.runtime!.act(context("principal-red", fixture.red.token), bytes);
  assert.equal(retry.disposition, "queued");
  assert.equal(runtimeRequestLedgerSnapshot(fixture.runtime!)!.record_count, 1);
  assert.equal(runtimeActionJournalStatus(fixture.runtime!)!.closed, false);
});
test("exact retry after a tick advance and failed restore replays after mechanics closure", () => {
  let callbacks = 0;
  let failRestore = true;
  const fixture = runtimeFixtureWithHooks({
    step: (input) => {
      const action = (input as { actions: readonly { sequence: number }[] }).actions[0]!;
      return { tick: 0, events: [], action_results: [{ accepted: true, sequence: action.sequence }] };
    },
    projectResult: () => { callbacks += 1; throw new Error("projection failure"); },
    failRestore: () => {
      if (!failRestore) return false;
      failRestore = false;
      return true;
    },
  });
  const bytes = runtimeActEnvelope("closed-replay", request);
  const first = fixture.runtime!.act(context("principal-red", fixture.red.token), bytes);
  assert.equal(first.disposition, "queued");
  const clock = readWorldRuntimeClockAuthority(fixture.runtime!)!;
  assert.throws(() => clock.stepDynamics(), /restore failed/u);
  const before = runtimeActionJournalSnapshot(fixture.runtime!)!;
  const beforeDecision = fixture.decisionRegistry.inspect();
  const beforeTick = fixture.dynamics.nextTick;
  assert.deepEqual(fixture.runtime!.act(context("principal-red", "wrong-token"), bytes), first);
  assert.equal(callbacks, 1);
  assert.deepEqual(runtimeActionJournalSnapshot(fixture.runtime!), before);
  assert.deepEqual(fixture.decisionRegistry.inspect(), beforeDecision);
  assert.equal(fixture.dynamics.nextTick, beforeTick);
  assert.equal(fixture.dynamics.snapshot().pending_actions.length, 0);
  assert.deepEqual(fixture.runtime!.act(context("principal-red", fixture.red.token), runtimeActEnvelope("new-after-close", request)), denied("ingress_closed"));
  assert.deepEqual(runtimeActionJournalSnapshot(fixture.runtime!), before);
});
