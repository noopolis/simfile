import assert from "node:assert/strict";
import test from "node:test";
import { DYNAMICS_LIMITS } from "../dynamics/limits.js";
import type { DynamicsSession } from "../dynamics/session.js";
import { createWorldActionJournal } from "./actionJournal.js";
import { resolveWorldActionStep } from "./actionResults.js";

const identity = Object.freeze({ run_id: "run", world_id: "world", world_instance_id: "instance", manifest_digest: `sha256:${"a".repeat(64)}`, state_version: 0 });
const add = (journal: ReturnType<typeof createWorldActionJournal>, sequence: number): void => {
  const receipt = Object.freeze({ disposition: "queued" as const, receipt_id: `world-act-${sequence}`, decision_id: `decision-${String(sequence).padStart(12, "0")}`, identity, apply_tick: 0 });
  const record = Object.freeze({ receipt_id: receipt.receipt_id, decision_id: receipt.decision_id, principal: "p", holder: "world://world/entity/p", affordance: "world://world/affordance/kick", target: "world://world/entity/p", at_tick: 0, dynamics_sequence: sequence, mechanics_action: "kick", mechanics_actor: "object:p", mechanics_target: "object:p", lowered_input: Object.freeze({}), identity });
  journal.audit("p", "queued"); const cell = journal.reserve(receipt, sequence); cell.persist(record); cell.prepareAuthorization(); cell.authorize();
};
const setup = (count = 1, dynamicsOptions: { readonly largeSnapshot?: boolean; readonly snapshotThrows?: boolean; readonly restoreThrows?: boolean } = {}) => {
  const journal = createWorldActionJournal(); journal.reservePrincipals(["p"]);
  for (let sequence = 1; sequence <= count; sequence += 1) add(journal, sequence);
  const state: Record<string, unknown> = dynamicsOptions.largeSnapshot
    ? { values: Array.from({ length: DYNAMICS_LIMITS.json_nodes + 1 }, () => ({ value: 0 })) }
    : { value: 0 };
  let projects = 0; let closed = 0; let restores = 0;
  // Direct resolver tests intentionally double only its snapshot/restore dependency.
  const dynamics: Pick<DynamicsSession, "snapshot" | "restore"> = {
    snapshot: () => {
      if (dynamicsOptions.snapshotThrows) throw new Error("snapshot");
      return structuredClone(state) as unknown as ReturnType<DynamicsSession["snapshot"]>;
    },
    restore: (value) => {
      if (dynamicsOptions.restoreThrows) throw new Error("restore");
      restores += 1;
      Object.assign(state, value as typeof state);
    },
  };
  const registry: { affordances: readonly { readonly address: string; readonly rejection_codes: readonly string[] }[]; projectAffordanceResult: () => unknown } = {
    affordances: [{ address: "affordance:kick", rejection_codes: ["blocked"] }], projectAffordanceResult: () => { projects += 1; return { outcome: "ok" }; },
  };
  const resolve = (results: readonly Record<string, unknown>[], options: { readonly reentered?: boolean; readonly project?: () => unknown; readonly resultReservation?: never } = {}) => {
    if (options.project !== undefined) registry.projectAffordanceResult = () => { projects += 1; return options.project!(); };
    resolveWorldActionStep({ dynamics: dynamics as DynamicsSession, surfaceRegistry: registry as never, journal, reservation: journal.reserveTerminals(0),
      step: { tick: 0, events: [], action_results: results as never }, reentered: () => options.reentered === true, closeMechanics: () => { closed += 1; } });
  };
  return { journal, resolve, projects: () => projects, closed: () => closed, restores: () => restores };
};
const result = (sequence: number, accepted = true, extra: Record<string, unknown> = {}) => ({ accepted, sequence, act_id: `world-act-${sequence}`, action: "kick", actor: "object:p", principal_id: "p", target: "object:p", apply_tick: 0, origin: "agentic", ...extra });

test("commits every exact mechanical fact before its first accepted projection", () => {
  const fixture = setup(2);
  let beforeFirstProjection: unknown;
  fixture.resolve([result(1), result(2)], { project: () => {
    beforeFirstProjection ??= fixture.journal.snapshot().cells.map((cell) => cell.terminal?.disposition);
    return { outcome: "ok" };
  } });
  assert.deepEqual(beforeFirstProjection, ["applied", "applied"]);
  assert.deepEqual(fixture.journal.snapshot().cells.map((cell) => [cell.terminal?.disposition, cell.terminal?.projection]), [["applied", "projected"], ["applied", "projected"]]);
  assert.equal(fixture.projects(), 2);
});

test("projects valid issued snapshots above the hostile JSON node ceiling", () => {
  const fixture = setup(1, { largeSnapshot: true });
  fixture.resolve([result(1)]);
  assert.equal(fixture.journal.snapshot().cells[0]!.terminal?.projection, "projected");
  assert.equal(fixture.projects(), 1);
  assert.equal(fixture.restores(), 0);
});

test("commits journal terminals before batch result publication and aborts no impossible join", () => {
  const fixture = setup(); let published = 0, aborted = 0, terminals: unknown;
  const reservation = Object.freeze({ resultId: () => "world-result-1", effectId: () => { throw new Error("no effects"); }, publish: () => { published += 1; terminals = fixture.journal.snapshot().cells[0]!.terminal?.disposition; }, abort: () => { aborted += 1; } });
  resolveWorldActionStep({ dynamics: { snapshot: () => ({}), restore: () => {} } as never, surfaceRegistry: { affordances: [{ address: "affordance:kick", rejection_codes: [] }], projectEffect: () => ({}) } as never, journal: fixture.journal, reservation: fixture.journal.reserveTerminals(0), step: { tick: 0, events: [], action_results: [result(1)] } as never, reentered: () => false, closeMechanics: () => {}, resultReservation: reservation, postMechanicsStateVersion: 1 });
  assert.equal(published, 1); assert.equal(terminals, "applied"); assert.equal(aborted, 0);
  const broken = setup(); const never = Object.freeze({ ...reservation, publish: () => { published += 100; }, abort: () => { aborted += 1; } });
  assert.throws(() => resolveWorldActionStep({ dynamics: {} as never, surfaceRegistry: {} as never, journal: broken.journal, reservation: broken.journal.reserveTerminals(0), step: { tick: 0, events: [], action_results: [] } as never, reentered: () => false, closeMechanics: () => {}, resultReservation: never, postMechanicsStateVersion: 1 }));
  assert.equal(aborted, 1); assert.equal(published, 1);
});

test("closes and aborts exactly once for either one-sided result configuration", () => {
  for (const withReservation of [false, true]) {
    let aborted = 0; const fixture = setup(); const configuration = withReservation
      ? { resultReservation: Object.freeze({ resultId: () => "world-result-1", effectId: () => "world-effect-1", publish: () => { throw new Error("publish"); }, abort: () => { aborted += 1; } }), postMechanicsStateVersion: undefined }
      : { resultReservation: undefined, postMechanicsStateVersion: 1 };
    assert.throws(() => resolveWorldActionStep({ dynamics: {} as never, surfaceRegistry: {} as never, journal: fixture.journal, reservation: fixture.journal.reserveTerminals(0), step: { tick: 0, events: [], action_results: [result(1)] } as never, reentered: () => false, closeMechanics: () => {}, ...configuration }));
    assert.equal(fixture.journal.snapshot().closed, true); assert.equal(fixture.journal.snapshot().cells[0]!.terminal, null); assert.equal(aborted, withReservation ? 1 : 0);
  }
});

test("keeps rejected mechanics terminal and exposes only declared codes", () => {
  const declared = setup(); declared.resolve([result(1, false, { code: "blocked", message: "host-only" })]);
  assert.deepEqual(declared.journal.snapshot().cells[0]!.terminal, { disposition: "rejected_at_mechanics", receipt_id: "world-act-1", decision_id: "decision-000000000001", sequence: 1, apply_tick: 0, projection: "not_configured", public_code: "blocked" });
  assert.equal(declared.projects(), 0);
  const hidden = setup(); hidden.resolve([result(1, false, { code: "provider-secret", message: "host-only" })]);
  assert.equal(hidden.journal.snapshot().cells[0]!.terminal?.public_code, "world_action_rejected");
  assert.equal(hidden.projects(), 0);
});

test("closes every impossible join with authorized pending evidence and no terminal facts", () => {
  const invalidResults: ReadonlyArray<readonly [string, readonly Record<string, unknown>[]]> = [
    ["missing", [result(1)]],
    ["duplicate", [result(1), result(1)]],
    ["foreign", [result(1), result(99)]],
    ["sequence", [result(1), result(2, true, { sequence: 99 })]],
    ["act_id", [result(1), result(2, true, { act_id: "world-act-1" })]],
    ["action", [result(1), result(2, true, { action: "wrong" })]],
    ["actor", [result(1), result(2, true, { actor: "object:wrong" })]],
    ["principal", [result(1), result(2, true, { principal_id: "wrong" })]],
    ["target", [result(1), result(2, true, { target: "wrong" })]],
    ["apply_tick", [result(1), result(2, true, { apply_tick: 1 })]],
  ];
  for (const [name, results] of invalidResults) for (const resultMode of [false, true]) {
    const fixture = setup(2); let aborted = 0, published = 0;
    const resultReservation = Object.freeze({ resultId: () => "world-result-1", effectId: () => "world-effect-1", publish: () => { published += 1; }, abort: () => { aborted += 1; } });
    assert.throws(() => resolveWorldActionStep({ dynamics: {} as never, surfaceRegistry: {} as never, journal: fixture.journal, reservation: fixture.journal.reserveTerminals(0), step: { tick: 0, events: [], action_results: results } as never, reentered: () => false, closeMechanics: () => {}, ...(resultMode ? { resultReservation, postMechanicsStateVersion: 1 } : {}) }), `${name}/${resultMode ? "result" : "legacy"}`);
    assert.throws(() => fixture.journal.reserveAudit("p"));
    const snapshot = fixture.journal.snapshot();
    assert.equal(snapshot.closed, true); assert.equal(aborted, resultMode ? 1 : 0); assert.equal(published, 0);
    assert.deepEqual(snapshot.cells.map((cell) => [cell.state, cell.terminal]), [["authorized", null], ["authorized", null]]);
  }
});

test("surfaces a result-reservation abort failure after closing a malformed join", () => {
  const fixture = setup(); let aborts = 0; let publishes = 0;
  const settlement = new Error("result settlement failed");
  const reservation = Object.freeze({ resultId: () => "world-result-1", effectId: () => "world-effect-1",
    publish: () => { publishes += 1; }, abort: () => { aborts += 1; throw settlement; } });
  assert.throws(() => resolveWorldActionStep({ dynamics: {} as never, surfaceRegistry: {} as never,
    journal: fixture.journal, reservation: fixture.journal.reserveTerminals(0),
    step: { tick: 0, events: [], action_results: [] } as never, reentered: () => false, closeMechanics: () => {},
    resultReservation: reservation, postMechanicsStateVersion: 1 }), (error) => error === settlement);
  assert.equal(aborts, 1); assert.equal(publishes, 0); assert.equal(fixture.journal.snapshot().closed, true);
});

test("projection failures retain applied mechanics and restore the post-step snapshot", () => {
  const fixture = setup();
  fixture.resolve([result(1)], { project: () => { throw new Error("projection"); } });
  assert.equal(fixture.journal.snapshot().cells[0]!.terminal?.disposition, "applied");
  assert.equal(fixture.journal.snapshot().cells[0]!.terminal?.projection, "failed");
  const reentered = setup(); reentered.resolve([result(1)], { reentered: true });
  assert.equal(reentered.projects(), 0);
  assert.equal(reentered.journal.snapshot().cells[0]!.terminal?.projection, "failed");
});

test("post-step snapshot failure closes mechanics and fails the current clock work", () => {
  const fixture = setup(1, { snapshotThrows: true });
  assert.throws(() => fixture.resolve([result(1)]), /post-step snapshot/u);
  assert.equal(fixture.closed(), 1);
  assert.equal(fixture.projects(), 0);
  const snapshot = fixture.journal.snapshot();
  assert.equal(snapshot.closed, true);
  assert.equal(snapshot.cells[0]!.terminal?.disposition, "applied");
  assert.equal(snapshot.cells[0]!.terminal?.projection, "not_configured");
});

test("restore failure closes mechanics and stops later projection callbacks", () => {
  const fixture = setup(2, { restoreThrows: true });
  assert.throws(() => fixture.resolve([result(1), result(2)], { project: () => { throw new Error("projection"); } }), /restore/u);
  assert.equal(fixture.projects(), 1);
  assert.equal(fixture.closed(), 1);
  const snapshot = fixture.journal.snapshot();
  assert.equal(snapshot.closed, true);
  assert.deepEqual(snapshot.cells.map((cell) => [cell.terminal?.disposition, cell.terminal?.projection]), [["applied", "not_configured"], ["applied", "not_configured"]]);
});
