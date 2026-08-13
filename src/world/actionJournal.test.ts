import assert from "node:assert/strict";
import test from "node:test";
import { createWorldActionJournal, readWorldActionJournalStatus } from "./actionJournal.js";

const identity = Object.freeze({ run_id: "run", world_id: "world", world_instance_id: "instance", manifest_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", state_version: 0 });
const receipt = Object.freeze({ disposition: "queued" as const, receipt_id: "world-act-1", decision_id: "decision-000000000001", identity, apply_tick: 0 });
const queued = Object.freeze({ receipt_id: "world-act-1", decision_id: "decision-000000000001", principal: "p", holder: "world://world/entity/p", affordance: "world://world/affordance/a", target: "world://world/entity/p", at_tick: 0, dynamics_sequence: 1, mechanics_action: "a", mechanics_actor: "object:p", mechanics_target: "object:p", lowered_input: Object.freeze({}), identity });
const populated = () => { const journal = createWorldActionJournal(); journal.reservePrincipals(["p"]); const audit = journal.reserveAudit("p"); const cell = journal.reserve(receipt, 1); cell.persist(queued); audit.commit("queued"); cell.prepareAuthorization(); cell.authorize(); return journal; };

test("persists before the no-fail authorization flip and abort removes provisional state", () => {
  const journal = createWorldActionJournal(); journal.reservePrincipals(["p"]);
  const cell = journal.reserve(receipt, 1); cell.persist(queued); assert.equal(journal.pending(0).length, 0);
  cell.abort(); assert.equal(journal.snapshot().cells.length, 0);
  const committed = populated(); assert.equal(committed.pending(0).length, 1);
});

test("uses literal reservations and leaves no payload or map after abort", () => {
  const journal = createWorldActionJournal(); journal.reservePrincipals(["p"]);
  const audit = journal.reserveAudit("p");
  const cell = journal.reserve(receipt, 1);
  assert.throws(() => cell.authorize());
  assert.throws(() => journal.snapshot());
  cell.persist(queued); assert.throws(() => journal.snapshot());
  cell.prepareAuthorization(); assert.throws(() => journal.snapshot()); audit.commit("queued");
  assert.doesNotThrow(() => cell.authorize());
  assert.throws(() => cell.authorize()); assert.throws(() => cell.abort());
  const provisional = journal.reserve(Object.freeze({ ...receipt, receipt_id: "world-act-2" }), 2);
  provisional.persist(Object.freeze({ ...queued, receipt_id: "world-act-2", dynamics_sequence: 2 }));
  provisional.abort();
  assert.equal(journal.snapshot().cells.length, 1);
});

test("round trips isolated journal state and terminal projection states", () => {
  const source = populated(); source.terminal(Object.freeze({ disposition: "applied", receipt_id: "world-act-1", decision_id: "decision-000000000001", sequence: 1, apply_tick: 0, projection: "not_configured" }));
  const snapshot = source.snapshot(); assert(Object.isFrozen(snapshot)); assert(Object.isFrozen(snapshot.cells)); assert(Object.isFrozen(snapshot.cells[0]!));
  const target = createWorldActionJournal(); target.restore(snapshot); assert.deepEqual(target.snapshot(), snapshot);
  assert.throws(() => target.restore(snapshot));
  const altered = structuredClone(snapshot); (altered.cells[0]!.receipt.identity as { run_id: string }).run_id = "other";
  assert.equal(source.snapshot().cells[0]!.receipt.identity.run_id, "run");
});

test("rejects hostile snapshots without getters and preserves a pristine journal", () => {
  const snapshot = populated().snapshot(); const accessor = structuredClone(snapshot) as unknown as Record<string, unknown>;
  Object.defineProperty(accessor, "closed", { enumerable: true, get: () => { throw new Error("getter"); } });
  const symbol = structuredClone(snapshot) as unknown as Record<PropertyKey, unknown>; symbol[Symbol("x")] = true;
  const alias = structuredClone(snapshot) as unknown as { cells: unknown[] }; alias.cells.push(alias.cells[0]!);
  for (const candidate of [undefined, {}, accessor, symbol, alias, { ...snapshot, version: "other" }, { ...snapshot, lanes: [] }]) {
    const journal = createWorldActionJournal(); assert.throws(() => journal.restore(candidate)); assert.deepEqual(journal.snapshot().cells, []);
  }
});

test("rejects unsafe queued payloads before authorization and keeps unknown lanes healthy", () => {
  const journal = createWorldActionJournal(); journal.reservePrincipals(["p"]);
  assert.throws(() => journal.reserveAudit("unknown"));
  const cell = journal.reserve(receipt, 1); let accessed = false;
  const getter = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(getter, "x", { enumerable: true, get: () => { accessed = true; return 1; } });
  const proxy = new Proxy({}, { get: () => { accessed = true; return 1; } });
  for (const lowered_input of [getter, proxy, { then: 1 }, [,,]]) {
    assert.throws(() => cell.persist(Object.freeze({ ...queued, lowered_input }) as typeof queued));
  }
  assert.equal(accessed, false); cell.abort(); assert.deepEqual(journal.snapshot().cells, []);
});

test("normalizes stable snapshots and restores only matching reserved principals", () => {
  const source = populated(); const snapshot = source.snapshot();
  const matching = createWorldActionJournal(); matching.reservePrincipals(["p"]); matching.restore(snapshot);
  assert.deepEqual(matching.snapshot(), snapshot);
  const mismatch = createWorldActionJournal(); mismatch.reservePrincipals(["other"]);
  assert.throws(() => mismatch.restore(snapshot));
  const altered = structuredClone(snapshot); (altered.cells as unknown[]).reverse(); (altered.lanes as unknown[]).reverse();
  const normalized = createWorldActionJournal(); normalized.restore(altered);
  assert.deepEqual(normalized.snapshot(), snapshot);
});

test("terminal audit capacity is immutable, denied-only, and closes after denial", () => {
  const journal = createWorldActionJournal(); journal.reservePrincipals(["p"]);
  for (let index = 0; index < 9_999; index += 1) journal.audit("p", "denied");
  const terminal = journal.reserveAudit("p");
  assert.equal(terminal.terminal_capacity, true);
  assert.throws(() => terminal.commit("queued"));
  terminal.commit("denied");
  assert.throws(() => journal.reserveAudit("p"));
  assert.throws(() => journal.audit("p", "denied"));
});

test("settles a pre-close outer audit after a terminal inner denial", () => {
  const journal = createWorldActionJournal(); journal.reservePrincipals(["p"]);
  for (let index = 0; index < 9_998; index += 1) journal.audit("p", "denied");
  const outer = journal.reserveAudit("p");
  const terminal = journal.reserveAudit("p");
  assert.equal(outer.terminal_capacity, false); assert.equal(terminal.terminal_capacity, true);
  terminal.commit("denied");
  assert.throws(() => journal.reserveAudit("p"));
  assert.throws(() => outer.commit("queued"));
  outer.commit("denied");
  assert.throws(() => outer.commit("denied"), /stale action journal reservation/u);
  assert.deepEqual(readWorldActionJournalStatus(journal), { closed: true, audit_count: 10_000, cell_count: 0 });
});
