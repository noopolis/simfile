import assert from "node:assert/strict";
import test from "node:test";
import { DYNAMICS_LIMITS } from "../dynamics/limits.js";
import { createWorldActionResultLedger, readWorldActionResultLedger } from "./actionResultLedger.js";
import { registerWorldRuntimeActionResultLedgerInspection, readWorldRuntimeActionResultLedgerInspection } from "./actionResultLedgerInspection.js";
import { actWorldRuntime, denyWith } from "./act.js";
import { createWorldActionJournal } from "./actionJournal.js";
import { createWorldRuntimeClockAuthority, readWorldRuntimeClockAuthority } from "./clockAuthority.js";
import { createWorldRequestLedger } from "./requestLedger.js";
import { runtimeActionResultLedger, runtimeActEnvelope, runtimeActionJournalSnapshot, runtimeActionJournalStatus, runtimeFixture, runtimeFixtureWithHooks } from "./runtime.test-helper.js";
import * as worldBarrel from "./index.js";
import * as packageBarrel from "../index.js";
import type { WorldActIngressRejectionReason } from "./actTypes.js";

const denied = (reason: WorldActIngressRejectionReason) => Object.freeze({
  disposition: "rejected_at_ingress" as const,
  code: "world_action_denied" as const,
  reason,
});

test("does not expose clock authority on WorldRuntime", () => {
  const fixture = runtimeFixture(); assert.equal("stepDynamics" in fixture.runtime, false); assert.ok(readWorldRuntimeClockAuthority(fixture.runtime));
});

test("provider reentry is denied before a second queue and makes projection fail", () => {
  let nested: unknown; let projectCalls = 0; let act: (() => unknown) | undefined;
  const fixture = runtimeFixtureWithHooks({
    step: (input) => {
      nested = act!();
      const action = (input as { actions: readonly { sequence: number }[] }).actions[0]!;
      return { tick: 0, events: [], action_results: [{ accepted: true, sequence: action.sequence }] };
    },
    projectResult: () => { projectCalls += 1; return { effect: "unexpected" }; },
  });
  act = () => fixture.runtime!.act({ principal: "principal-blue", decisionToken: fixture.blue.token }, runtimeActEnvelope("clock-blue-reentry", { affordance: "world://pitch/affordance/wait", target: "world://pitch/entity/blue", input: { force: 1 } }));
  assert.equal(fixture.runtime!.act({ principal: "principal-red", decisionToken: fixture.red.token }, runtimeActEnvelope("clock-red", { affordance: "world://pitch/affordance/kick", target: "world://pitch/entity/ball", input: { force: 1 } })).disposition, "queued");
  readWorldRuntimeClockAuthority(fixture.runtime!)!.stepDynamics();
  assert.deepEqual(nested, denied("ingress_reentered"));
  assert.equal(projectCalls, 0);
  assert.equal(fixture.dynamics.snapshot().pending_actions.length, 0);
  assert.equal(fixture.runtime!.act({ principal: "principal-blue", decisionToken: fixture.blue.token }, runtimeActEnvelope("clock-blue-after", { affordance: "world://pitch/affordance/wait", target: "world://pitch/entity/blue", input: { force: 1 } })).disposition, "queued");
});

test("caught projection and nested clock reentry cannot run a second clock", () => {
  let nestedClockCalls = 0; let clock: ReturnType<typeof readWorldRuntimeClockAuthority>;
  const fixture = runtimeFixtureWithHooks({
    step: (input) => {
      try { clock!.stepDynamics(); } catch { nestedClockCalls += 1; }
      const action = (input as { actions: readonly { sequence: number }[] }).actions[0]!;
      return { tick: 0, events: [], action_results: [{ accepted: true, sequence: action.sequence }] };
    },
  });
  clock = readWorldRuntimeClockAuthority(fixture.runtime!);
  assert.equal(fixture.runtime!.act({ principal: "principal-red", decisionToken: fixture.red.token }, runtimeActEnvelope("clock-red-projection", { affordance: "world://pitch/affordance/kick", target: "world://pitch/entity/ball", input: { force: 1 } })).disposition, "queued");
  clock!.stepDynamics();
  assert.equal(nestedClockCalls, 1);
  assert.equal(fixture.dynamics.nextTick, 1);
});

test("caught projection reentry receives one denial without an orphaned queue", () => {
  let projectCalls = 0; let nested: unknown; let act: (() => unknown) | undefined;
  const fixture = runtimeFixtureWithHooks({
    step: (input) => {
      const action = (input as { actions: readonly { sequence: number }[] }).actions[0]!;
      return { tick: 0, events: [], action_results: [{ accepted: true, sequence: action.sequence }] };
    },
    projectResult: () => { projectCalls += 1; nested = act!(); return { ignored: true }; },
  });
  act = () => fixture.runtime!.act({ principal: "principal-blue", decisionToken: fixture.blue.token }, runtimeActEnvelope("clock-blue-projection-reentry", { affordance: "world://pitch/affordance/wait", target: "world://pitch/entity/blue", input: { force: 1 } }));
  assert.equal(fixture.runtime!.act({ principal: "principal-red", decisionToken: fixture.red.token }, runtimeActEnvelope("clock-red-projection", { affordance: "world://pitch/affordance/kick", target: "world://pitch/entity/ball", input: { force: 1 } })).disposition, "queued");
  readWorldRuntimeClockAuthority(fixture.runtime!)!.stepDynamics();
  assert.equal(projectCalls, 1);
  assert.deepEqual(nested, denied("ingress_reentered"));
  assert.equal(fixture.dynamics.snapshot().pending_actions.length, 0);
  assert.equal(fixture.runtime!.act({ principal: "principal-blue", decisionToken: fixture.blue.token }, runtimeActEnvelope("clock-blue-after-projection", { affordance: "world://pitch/affordance/wait", target: "world://pitch/entity/blue", input: { force: 1 } })).disposition, "queued");
});

test("provider throws abort the terminal reservation and retain pending mechanics", () => {
  let throws = true;
  const fixture = runtimeFixtureWithHooks({ step: (input) => {
    if (throws) { throws = false; throw new Error("provider"); }
    const action = (input as { actions: readonly { sequence: number }[] }).actions[0]!;
    return { tick: 0, events: [], action_results: [{ accepted: true, sequence: action.sequence }] };
  } });
  assert.equal(fixture.runtime!.act({ principal: "principal-red", decisionToken: fixture.red.token }, runtimeActEnvelope("clock-red-throw", { affordance: "world://pitch/affordance/kick", target: "world://pitch/entity/ball", input: { force: 1 } })).disposition, "queued");
  const clock = readWorldRuntimeClockAuthority(fixture.runtime!)!;
  assert.throws(() => clock.stepDynamics());
  assert.equal(fixture.dynamics.nextTick, 0);
  assert.equal(fixture.dynamics.snapshot().pending_actions.length, 1);
  assert.equal(clock.stepDynamics().tick, 0);
});

type IssuedFixture = ReturnType<typeof runtimeFixtureWithHooks> & {
  readonly runtime: NonNullable<ReturnType<typeof runtimeFixtureWithHooks>["runtime"]>;
};
const bindResultLedger = (fixture: IssuedFixture) => {
  const ledger = runtimeActionResultLedger(fixture.runtime);
  assert.ok(ledger);
  return ledger;
};

const pageRequest = Object.freeze({ version: "simfile.world-action-result-page-request.v1" as const, limit: 100 });
const queue = (fixture: IssuedFixture, principal: "principal-red" | "principal-blue", token: string, requestId: string, affordance: "kick" | "wait") => {
  const target = principal === "principal-red" ? "world://pitch/entity/ball" : "world://pitch/entity/blue";
  const receipt = fixture.runtime.act({ principal, decisionToken: token }, runtimeActEnvelope(requestId, {
    affordance: `world://pitch/affordance/${affordance}`, target, input: { force: 1 },
  }));
  assert.equal(receipt.disposition, "queued"); return receipt;
};

const lowerClockFixture = (hooks: Parameters<typeof runtimeFixtureWithHooks>[0], wrongBinding = false, register = true) => {
  const fixture = runtimeFixtureWithHooks(hooks, false);
  const runtime = {};
  const journal = createWorldActionJournal();
  journal.reservePrincipals(fixture.capabilityManifests.map(({ manifest }) => manifest.holder.principal));
  const requestLedger = createWorldRequestLedger({ max_records: DYNAMICS_LIMITS.retained_action_records - 1 });
  let closed = false;
  const operation = Object.freeze({
    enter: () => { if (closed) throw new Error("lower clock closed"); }, leave: () => {}, reentered: () => false,
    close: () => { closed = true; requestLedger.close(); journal.close(); },
  });
  createWorldRuntimeClockAuthority(runtime, { dynamics: fixture.dynamics, surfaceRegistry: fixture.surfaceRegistry, journal, operation });
  const ledger = createWorldActionResultLedger();
  readWorldActionResultLedger(ledger)!.reserve({ bindings: fixture.capabilityManifests.map(({ manifest }) => ({
    principal: manifest.holder.principal, actor: wrongBinding ? "world://pitch/entity/blue" : manifest.holder.entity, run_id: manifest.run_id,
    world_id: manifest.world.id, world_instance_id: manifest.world.instance_id, manifest_digest: manifest.manifest_digest,
  })) });
  const bind = () => registerWorldRuntimeActionResultLedgerInspection(runtime, ledger);
  if (register) bind();
  const queueLower = (principal: "principal-red" | "principal-blue", token: string, requestId: string, affordance: "kick" | "wait") => {
    const manifest = fixture.capabilityManifests.find(({ manifest: value }) => value.holder.principal === principal)!.manifest;
    return actWorldRuntime({ dynamics: fixture.dynamics, surfaceRegistry: fixture.surfaceRegistry, decisionRegistry: fixture.decisionRegistry,
      journal, requestLedger, runId: "run-1", worldId: "pitch", worldInstanceId: "instance-1", closeMechanics: operation.close, refuse: denyWith },
    manifest, principal, token, runtimeActEnvelope(requestId, { affordance: `world://pitch/affordance/${affordance}`,
      target: principal === "principal-red" ? "world://pitch/entity/ball" : "world://pitch/entity/blue", input: { force: 1 } }), () => false);
  };
  return { ...fixture, runtime, journal, ledger, bind, queueLower, closed: () => closed };
};

test("result inspection is issued, read-only, isolated, and reserves before the real checked step", () => {
  let sawStep = false;
  const fixture = runtimeFixtureWithHooks({
    step: (input) => {
      sawStep = true;
      const action = (input as { readonly actions: readonly { readonly sequence: number }[] }).actions[0]!;
      return { tick: 0, events: [], action_results: [{ accepted: true, sequence: action.sequence }] };
    },
  });
  bindResultLedger(fixture as IssuedFixture);
  const handle = readWorldRuntimeActionResultLedgerInspection(fixture.runtime!)!;
  assert.deepEqual(Reflect.ownKeys(handle), ["read"]);
  assert.equal(Object.isFrozen(handle), true);
  assert.equal("reserveBatch" in handle, false);
  assert.ok(readWorldRuntimeActionResultLedgerInspection(runtimeFixtureWithHooks({}).runtime));
  const receipt = fixture.runtime!.act({ principal: "principal-red", decisionToken: fixture.red.token }, runtimeActEnvelope("result-clock", { affordance: "world://pitch/affordance/kick", target: "world://pitch/entity/ball", input: { force: 1 } }));
  assert.equal(receipt.disposition, "queued");
  assert.equal(handle.read("principal-red", { version: "simfile.world-action-result-page-request.v1" }).results.length, 0);
  assert.deepEqual(readWorldRuntimeClockAuthority(fixture.runtime)!.stepDynamics(), { tick: 0, action_results: 1, events: 0 });
  assert.equal(sawStep, true);
  const page = handle.read("principal-red", { version: "simfile.world-action-result-page-request.v1" });
  assert.equal(page.results.length, 1);
  assert.equal(page.results[0]!.identity.state_version, 1);
  assert.equal(page.results[0]!.identity.manifest_digest, fixture.capabilityManifests.find(({ manifest }) => manifest.holder.principal === "principal-red")!.manifest.manifest_digest);
});

test("result inspection rejects forged, reused, cross-registered, and trapped inputs without executing traps", () => {
  const first = runtimeFixtureWithHooks({}); const second = runtimeFixtureWithHooks({}); const ledger = createWorldActionResultLedger();
  const fake = { read: () => { throw new Error("fake"); } } as never;
  assert.throws(() => registerWorldRuntimeActionResultLedgerInspection({} as object, ledger), /invalid/u);
  assert.throws(() => registerWorldRuntimeActionResultLedgerInspection(first.runtime!, fake), /invalid/u);
  bindResultLedger(first as IssuedFixture);
  const firstLedger = readWorldRuntimeActionResultLedgerInspection(first.runtime!)!;
  assert.throws(() => registerWorldRuntimeActionResultLedgerInspection(first.runtime!, createWorldActionResultLedger()), /invalid/u);
  assert.throws(() => registerWorldRuntimeActionResultLedgerInspection(second.runtime!, firstLedger), /invalid/u);
  let trapped = 0;
  const proxy = new Proxy(ledger, { get: () => { trapped += 1; return undefined; }, ownKeys: () => { trapped += 1; return []; } });
  assert.throws(() => registerWorldRuntimeActionResultLedgerInspection(second.runtime!, proxy), /invalid/u);
  const runtimeProxy = new Proxy(first.runtime!, { get: () => { trapped += 1; return undefined; }, ownKeys: () => { trapped += 1; return []; } });
  assert.throws(() => registerWorldRuntimeActionResultLedgerInspection(runtimeProxy, createWorldActionResultLedger()), /invalid/u);
  assert.throws(() => registerWorldRuntimeActionResultLedgerInspection(second.runtime!, { ...ledger }), /invalid/u);
  const accessor = Object.create(Object.prototype, { read: { enumerable: true, get: () => { trapped += 1; return ledger.read; } } });
  assert.throws(() => registerWorldRuntimeActionResultLedgerInspection(second.runtime!, accessor), /invalid/u);
  assert.equal(trapped, 0);
  assert.ok(readWorldActionResultLedger(ledger));
  assert.equal("registerWorldRuntimeActionResultLedgerInspection" in worldBarrel, false);
  assert.equal("registerWorldRuntimeActionResultLedgerInspection" in packageBarrel, false);
});

test("result mode reserves strict queued order, uses the checked event ceiling, and publishes zero-action ticks without a batch", () => {
  let eventCount = 0; let authority: ReturnType<typeof readWorldActionResultLedger>;
  const fixture = runtimeFixtureWithHooks({ step: (input) => {
    assert.equal(authority!.hasLiveReservation(), true);
    const actions = (input as { readonly actions: readonly { readonly sequence: number }[] }).actions;
    eventCount = DYNAMICS_LIMITS.events_per_tick;
    return { tick: (input as { readonly tick: number }).tick, action_results: actions.map(({ sequence }) => ({ accepted: true, sequence })), events: Array.from({ length: eventCount }, () => ({
      cause_action_sequences: [1, 2], kind: "impact", payload: { strength: 1 }, source: "system:test", target: "object:ball",
    })) };
  } });
  const ledger = bindResultLedger(fixture as IssuedFixture);
  authority = readWorldActionResultLedger(ledger)!;
  assert.deepEqual(readWorldRuntimeActionResultLedgerInspection(fixture.runtime!)!.read("principal-red", pageRequest).results, []);
  queue(fixture as IssuedFixture, "principal-red", fixture.red.token, "ceiling-red", "kick");
  queue(fixture as IssuedFixture, "principal-blue", fixture.blue.token, "ceiling-blue", "wait");
  const result = readWorldRuntimeClockAuthority(fixture.runtime!)!.stepDynamics();
  assert.equal(result.events, eventCount); assert.equal(authority.hasLiveReservation(), false);
  const red = ledger.read("principal-red", pageRequest).results[0]!;
  const blue = ledger.read("principal-blue", pageRequest).results[0]!;
  assert.equal(red.result_id, "world-result-1"); assert.equal(blue.result_id, "world-result-2");
  assert.equal(red.action_sequence, 1); assert.equal(blue.action_sequence, 2);
  assert.equal(red.identity.state_version, 1); assert.equal(blue.identity.state_version, 1);
  assert.equal(red.identity.manifest_digest === blue.identity.manifest_digest, false);
  assert.equal(red.status, "applied"); assert.equal(blue.status, "applied");
  const appliedRed = red as Extract<typeof red, { status: "applied" }>;
  const appliedBlue = blue as Extract<typeof blue, { status: "applied" }>;
  assert.equal(appliedRed.caused_effect_ids.length, DYNAMICS_LIMITS.events_per_tick);
  assert.deepEqual(appliedRed.caused_effect_ids.slice(0, 2), ["world-effect-1", "world-effect-2"]);
  assert.equal(appliedRed.caused_effect_ids.at(-1), `world-effect-${DYNAMICS_LIMITS.events_per_tick}`);
  assert.deepEqual(appliedBlue.caused_effect_ids, appliedRed.caused_effect_ids);

  let calls = 0;
  let emptyAuthority: ReturnType<typeof readWorldActionResultLedger>;
  const empty = runtimeFixtureWithHooks({ step: () => { calls += 1; assert.equal(emptyAuthority!.hasLiveReservation(), false); return { tick: 0, action_results: [], events: [] }; } });
  const emptyLedger = bindResultLedger(empty as IssuedFixture);
  emptyAuthority = readWorldActionResultLedger(emptyLedger)!;
  assert.deepEqual(readWorldRuntimeClockAuthority(empty.runtime!)!.stepDynamics(), { tick: 0, action_results: 0, events: 0 });
  assert.equal(calls, 1); assert.equal(readWorldActionResultLedger(emptyLedger)!.hasLiveReservation(), false);
  assert.deepEqual(emptyLedger.read("principal-red", pageRequest).results, []);
});

test("result mode preserves cursor continuity and distinguishes rejected declared codes", () => {
  const fixture = runtimeFixtureWithHooks({ step: (input) => ({ tick: (input as { readonly tick: number }).tick, events: [], action_results: (input as { readonly actions: readonly { readonly sequence: number }[] }).actions.map(({ sequence }) => ({
    accepted: sequence === 1, ...(sequence === 2 ? { code: "blocked" } : {}), sequence,
  })) }) });
  const ledger = bindResultLedger(fixture as IssuedFixture);
  const first = queue(fixture as IssuedFixture, "principal-red", fixture.red.token, "cursor-red", "kick");
  assert.equal(first.disposition, "queued");
  assert.equal(readWorldRuntimeClockAuthority(fixture.runtime!)!.stepDynamics().action_results, 1);
  const firstPage = ledger.read("principal-red", { ...pageRequest, limit: 1 });
  assert.equal(firstPage.results[0]!.status, "applied"); assert.ok(firstPage.next_result_after);
  const secondToken = fixture.decisionRegistry.mint({ principal: "principal-red", issuedTick: 1, validThroughTick: 2 }).token;
  queue(fixture as IssuedFixture, "principal-red", secondToken, "cursor-red-2", "kick");
  assert.equal(readWorldRuntimeClockAuthority(fixture.runtime!)!.stepDynamics().action_results, 1);
  const secondPage = ledger.read("principal-red", { ...pageRequest, limit: 1, result_after: firstPage.next_result_after });
  assert.equal(secondPage.results.length, 1); assert.equal(secondPage.results[0]!.result_id, "world-result-2");
  assert.equal(secondPage.results[0]!.status, "rejected_at_mechanics"); assert.equal(secondPage.results[0]!.rejection_code, "blocked");
  assert.equal("caused_effect_ids" in secondPage.results[0]!, false); assert.equal(secondPage.results[0]!.receipt_id, "world-act-2");
  assert.equal(runtimeActionJournalSnapshot(fixture.runtime!)!.cells.every((cell) => cell.terminal !== null), true);
});

test("an exhausted result counter fails before mechanics, settles the terminal reservation, and forbids retry", () => {
  let mechanicsSteps = 0;
  const fixture = lowerClockFixture({ step: (input) => { mechanicsSteps += 1; return { tick: (input as { readonly tick: number }).tick, events: [], action_results: (input as { readonly actions: readonly { readonly sequence: number }[] }).actions.map(({ sequence }) => ({ accepted: true, sequence })) }; } }, false, false);
  const first = fixture.queueLower("principal-red", fixture.red.token, "boundary-1", "kick");
  assert.equal(first.disposition, "queued");
  const clock = readWorldRuntimeClockAuthority(fixture.runtime)!;
  assert.equal(clock.stepDynamics().tick, 0);
  const authority = readWorldActionResultLedger(fixture.ledger)!;
  const redManifest = fixture.capabilityManifests.find(({ manifest }) => manifest.holder.principal === "principal-red")!.manifest;
  authority.append({ principal: "principal-red", declared_rejection_codes: [], result: {
    version: "simfile.world-action-result.v1", result_id: `world-result-${Number.MAX_SAFE_INTEGER - 2}`,
    receipt_id: first.receipt_id, decision_id: first.decision_id, actor: "world://pitch/entity/red", action_sequence: 1,
    apply_tick: 0, status: "applied", caused_effect_ids: [], identity: {
      run_id: "run-1", world_id: "pitch", world_instance_id: "instance-1", manifest_digest: redManifest.manifest_digest, state_version: 1,
    },
  } });
  fixture.bind();
  const baseline = fixture.ledger.read("principal-red", pageRequest);
  assert.equal(fixture.queueLower("principal-blue", fixture.blue.token, "boundary-2", "wait").disposition, "queued");
  assert.throws(() => clock.stepDynamics(), /invalid|construction/u);
  assert.equal(fixture.dynamics.nextTick, 1); assert.equal(mechanicsSteps, 1);
  assert.equal(authority.hasLiveReservation(), false);
  assert.deepEqual(fixture.ledger.read("principal-red", pageRequest), baseline);
  assert.equal(fixture.journal.snapshot().closed, true);
  assert.equal(fixture.journal.snapshot().cells[0]!.state, "terminal");
  assert.ok(fixture.journal.snapshot().cells[0]!.terminal);
  assert.equal(fixture.journal.snapshot().cells[1]!.terminal, null);
  assert.equal(fixture.closed(), true);
  assert.throws(() => clock.stepDynamics(), /closed|operation/u);
});

test("a valid checked step followed by publication failure keeps a committed terminal, no page, and no second step", () => {
  const fixture = lowerClockFixture({ step: (input) => ({ tick: 0, events: [], action_results: (input as { readonly actions: readonly { readonly sequence: number }[] }).actions.map(({ sequence }) => ({ accepted: true, sequence })) }) }, true);
  assert.equal(fixture.queueLower("principal-red", fixture.red.token, "publish-fail", "kick").disposition, "queued");
  const clock = readWorldRuntimeClockAuthority(fixture.runtime!)!;
  assert.throws(() => clock.stepDynamics());
  assert.equal(readWorldActionResultLedger(fixture.ledger)!.hasLiveReservation(), false);
  assert.equal(fixture.ledger.read("principal-red", pageRequest).results.length, 0);
  assert.equal(fixture.journal.snapshot().cells[0]!.terminal?.disposition, "applied");
  assert.equal(fixture.journal.snapshot().closed, true);
  assert.equal(fixture.closed(), true);
  assert.throws(() => clock.stepDynamics(), /closed|operation/u);
});

test("a failure after publication retains exactly one visible result and closes the checked session", () => {
  const fixture = runtimeFixtureWithHooks({
    step: (input) => ({ tick: (input as { readonly tick: number }).tick, events: [], action_results: (input as { readonly actions: readonly { readonly sequence: number }[] }).actions.map(({ sequence }) => ({ accepted: true, sequence })) }),
    projectResult: () => { throw new Error("post-publication projection"); },
    failRestore: () => true,
  });
  const ledger = bindResultLedger(fixture as IssuedFixture);
  queue(fixture as IssuedFixture, "principal-red", fixture.red.token, "post-publish", "kick");
  const clock = readWorldRuntimeClockAuthority(fixture.runtime!)!;
  assert.throws(() => clock.stepDynamics(), /post-publication projection|projection/u);
  assert.equal(ledger.read("principal-red", pageRequest).results.length, 1);
  assert.equal(ledger.read("principal-red", pageRequest).results[0]!.result_id, "world-result-1");
  assert.equal(readWorldActionResultLedger(ledger)!.hasLiveReservation(), false);
  assert.equal(runtimeActionJournalStatus(fixture.runtime!)!.closed, true);
  assert.throws(() => clock.stepDynamics(), /closed|operation/u);
});

test("result-mode step throws abort both reservations, remain retryable, and reuse the first ids", () => {
  let fail = true;
  const fixture = runtimeFixtureWithHooks({ step: (input) => {
    if (fail) { fail = false; throw new Error("checked step"); }
    const action = (input as { readonly actions: readonly { readonly sequence: number }[] }).actions[0]!;
    return { tick: 0, events: [{ cause_action_sequences: [action.sequence], kind: "impact", payload: { strength: 1 }, source: "system:test", target: "object:ball" }], action_results: [{ accepted: true, sequence: action.sequence }] };
  } });
  const ledger = bindResultLedger(fixture as IssuedFixture);
  const authority = readWorldActionResultLedger(ledger)!;
  assert.equal(fixture.runtime!.act({ principal: "principal-red", decisionToken: fixture.red.token }, runtimeActEnvelope("result-retry", { affordance: "world://pitch/affordance/kick", target: "world://pitch/entity/ball", input: { force: 1 } })).disposition, "queued");
  const clock = readWorldRuntimeClockAuthority(fixture.runtime!)!;
  assert.throws(() => clock.stepDynamics(), /checked step/u);
  assert.equal(authority.hasLiveReservation(), false);
  assert.equal(clock.stepDynamics().tick, 0);
  const result = authority.read("principal-red", { version: "simfile.world-action-result-page-request.v1" }).results[0]!;
  assert.equal(result.result_id, "world-result-1");
  assert.equal(result.action_sequence, 1);
  assert.deepEqual((result as Extract<typeof result, { status: "applied" }>).caused_effect_ids, ["world-effect-1"]);
});
