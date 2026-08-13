import assert from "node:assert/strict";
import test from "node:test";
import { createWorldActionJournal } from "./actionJournal.js";
import type { WorldActionJournalSnapshot } from "./actionJournalSnapshot.js";

const identity = (tick = 0) => ({
  run_id: "run", world_id: "world", world_instance_id: "instance",
  manifest_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  state_version: tick,
});

const receipt = (sequence: number, tick = 0) => ({
  disposition: "queued" as const, receipt_id: `world-act-${sequence}`,
  decision_id: `decision-${String(sequence).padStart(12, "0")}`, identity: identity(tick), apply_tick: tick,
});

const queued = (sequence: number, principal = "p", tick = 0) => ({
  receipt_id: `world-act-${sequence}`, decision_id: `decision-${String(sequence).padStart(12, "0")}`,
  principal, holder: "world://world/entity/p", affordance: "world://world/affordance/a",
  target: "world://world/entity/p", at_tick: tick, dynamics_sequence: sequence,
  mechanics_action: "action", mechanics_actor: "object:p", mechanics_target: "object:p",
  lowered_input: { nested: { value: 1 } }, identity: identity(tick),
});

const authorized = (withAudit = true) => {
  const journal = createWorldActionJournal();
  journal.reservePrincipals(["p", "q"]);
  if (withAudit) journal.audit("p", "queued");
  const cell = journal.reserve(receipt(1), 1);
  cell.persist(queued(1));
  cell.prepareAuthorization();
  cell.authorize();
  return journal;
};

const terminal = (journal: ReturnType<typeof authorized>, projection: "not_configured" | "projected" | "failed", disposition: "applied" | "rejected_at_mechanics" = "applied") => {
  journal.terminal({
    disposition, receipt_id: "world-act-1", decision_id: "decision-000000000001", sequence: 1, apply_tick: 0,
    projection: "not_configured", ...(disposition === "rejected_at_mechanics" ? { public_code: "blocked" } : {}),
  });
  if (projection !== "not_configured") journal.project({
    disposition, receipt_id: "world-act-1", decision_id: "decision-000000000001", sequence: 1, apply_tick: 0,
    projection, ...(projection === "projected" ? { effect: { outcome: "ok" } } : {}),
    ...(disposition === "rejected_at_mechanics" ? { public_code: "blocked" } : {}),
  });
  return journal;
};

const emptySnapshot = (): WorldActionJournalSnapshot => createWorldActionJournal().snapshot();
const altered = (snapshot: WorldActionJournalSnapshot): Record<string, any> => structuredClone(snapshot) as Record<string, any>;
const rejectsPristine = (candidate: unknown): void => {
  const target = createWorldActionJournal();
  assert.throws(() => target.restore(candidate));
  assert.deepEqual(target.snapshot(), emptySnapshot());
};

test("round trips every stable state and continues after restore", () => {
  const denied = createWorldActionJournal();
  denied.reservePrincipals(["p", "q"]);
  denied.audit("p", "denied");
  const snapshots = [
    emptySnapshot(), denied.snapshot(), authorized().snapshot(),
    terminal(authorized(), "not_configured", "rejected_at_mechanics").snapshot(),
    terminal(authorized(), "not_configured").snapshot(),
    terminal(authorized(), "projected").snapshot(),
    terminal(authorized(), "failed").snapshot(),
  ];
  for (const snapshot of snapshots) {
    const restored = createWorldActionJournal();
    restored.restore(snapshot);
    assert.deepEqual(restored.snapshot(), snapshot);
    assert.equal(restored.snapshot().cells.length, snapshot.cells.length);
  }

  const pending = createWorldActionJournal();
  pending.restore(authorized().snapshot());
  assert.equal(pending.pending(0).length, 1);
  pending.terminal({ disposition: "applied", receipt_id: "world-act-1", decision_id: "decision-000000000001", sequence: 1, apply_tick: 0, projection: "not_configured" });
  pending.project({ disposition: "applied", receipt_id: "world-act-1", decision_id: "decision-000000000001", sequence: 1, apply_tick: 0, projection: "projected", effect: { outcome: "continued" } });
  assert.equal(pending.snapshot().cells[0]!.terminal?.projection, "projected");
  pending.close();
  assert.throws(() => pending.reserveAudit("p"));
});

test("canonicalizes lanes, audits, and cells while preserving all counts", () => {
  const source = createWorldActionJournal();
  source.reservePrincipals(["q", "p"]);
  source.audit("p", "denied");
  source.audit("p", "queued");
  const cell = source.reserve(receipt(1), 1);
  cell.persist(queued(1));
  cell.prepareAuthorization();
  cell.authorize();
  const candidate = altered(source.snapshot());
  candidate.lanes.reverse();
  candidate.audits.reverse();
  candidate.cells.reverse();
  const restored = createWorldActionJournal();
  restored.restore(candidate);
  assert.deepEqual(restored.snapshot(), source.snapshot());
  assert.deepEqual(restored.snapshot().lanes.map((lane) => lane.principal), ["p", "q"]);
  assert.deepEqual(restored.snapshot().audits.map((audit) => [audit.principal, audit.result]), [["p", "denied"], ["p", "queued"]]);
});

test("rejects authority smuggling in restored lowered input and projected effects", () => {
  for (const field of ["token", "decision_id", "principal", "receipt", "receipt_id", "audit", "effect", "tick", "origin", "run_id", "world_id"]) {
    const candidate = altered(authorized().snapshot());
    candidate.cells[0].record.lowered_input = { nested: { [field]: "smuggled" } };
    assert.equal(candidate.cells[0].record.lowered_input.nested[field], "smuggled");
    rejectsPristine(candidate);
  }
  for (const field of ["token", "decision_id", "principal", "receipt", "receipt_id", "audit", "effect", "tick", "origin", "run_id", "world_id"]) {
    const candidate = altered(terminal(authorized(), "projected").snapshot());
    candidate.cells[0].terminal.effect = { nested: { [field]: "smuggled" } };
    assert.equal(candidate.cells[0].terminal.effect.nested[field], "smuggled");
    rejectsPristine(candidate);
  }
});

test("rejects root, cell, relation, and transient-state mutations without changing target", () => {
  const snapshot = terminal(authorized(), "projected").snapshot();
  const mutations: Array<(candidate: Record<string, any>) => void> = [
    (value) => { delete value.version; },
    (value) => { value.version = "other"; },
    (value) => { value.extra = true; },
    (value) => { delete value.lanes; },
    (value) => { value.lanes[0].count = 0; },
    (value) => { value.lanes.push({ principal: "p", count: 0 }); },
    (value) => { value.audits[0].result = "other"; },
    (value) => { value.audits.push({ principal: "p", result: "queued" }); },
    (value) => { value.cells[0].state = "prepared"; },
    (value) => { value.cells[0].sequence = 2; },
    (value) => { value.cells[0].receipt.receipt_id = "world-act-2"; },
    (value) => { value.cells[0].receipt.decision_id = "decision-000000000002"; },
    (value) => { value.cells[0].receipt.apply_tick = 1; },
    (value) => { value.cells[0].receipt.identity.world_id = "other"; },
    (value) => { value.cells[0].record.principal = "q"; },
    (value) => { value.cells[0].record.dynamics_sequence = 2; },
    (value) => { value.cells[0].record.identity.run_id = "other"; },
    (value) => { value.cells[0].terminal.decision_id = "decision-000000000002"; },
    (value) => { value.cells[0].terminal.sequence = 2; },
    (value) => { value.cells[0].terminal.apply_tick = 1; },
    (value) => { value.cells[0].terminal.projection = "bad"; },
  ];
  for (const mutate of mutations) {
    const candidate = altered(snapshot);
    mutate(candidate);
    rejectsPristine(candidate);
  }
  const orphan = altered(emptySnapshot());
  orphan.lanes = [{ principal: "p", count: 1 }];
  orphan.audits = [{ principal: "p", result: "queued" }];
  rejectsPristine(orphan);
  const duplicate = altered(snapshot);
  duplicate.cells.push(structuredClone(duplicate.cells[0]));
  rejectsPristine(duplicate);
});

test("rejects proxy, accessor, alias, bounds, and transient snapshot input", () => {
  const snapshot = authorized().snapshot();
  let traps = 0;
  const proxy = new Proxy(snapshot, { get: () => { traps += 1; return undefined; } });
  rejectsPristine(proxy);
  assert.equal(traps, 0);
  const accessor = altered(snapshot);
  Object.defineProperty(accessor, "closed", { enumerable: true, get: () => { traps += 1; return false; } });
  rejectsPristine(accessor);
  assert.equal(traps, 0);
  const alias = altered(snapshot);
  alias.cells.push(alias.cells[0]);
  rejectsPristine(alias);
  const tooMany = altered(snapshot);
  tooMany.cells = new Array(10_001);
  Object.defineProperty(tooMany.cells, "0", { enumerable: true, get: () => { traps += 1; throw new Error("must not read"); } });
  rejectsPristine(tooMany);
  assert.equal(traps, 0);
});

test("parses a reachable aggregate history above the generic JSON graph budget", () => {
  const journal = createWorldActionJournal();
  const principals = Array.from({ length: 10_000 }, (_, index) => `p${String(index).padStart(5, "0")}`);
  journal.reservePrincipals(principals);
  const cell = journal.reserve(receipt(1), 1); cell.persist(queued(1, principals[0]!)); cell.prepareAuthorization(); cell.authorize();
  journal.audit(principals[0]!, "queued");
  for (let index = 1; index < principals.length; index += 1) journal.audit(principals[index]!, "denied");
  const snapshot = journal.snapshot();
  assert.equal(snapshot.lanes.length, 10_000);
  assert.equal(snapshot.audits.length, 10_000);
  assert.equal(snapshot.audits.filter((audit) => audit.result === "queued").length, 1);
  assert.equal(snapshot.cells.length, 1);
  const restored = createWorldActionJournal(); restored.restore(snapshot);
  assert.deepEqual(restored.snapshot(), snapshot);
});

test("restores exactly 10,000 independently valid terminal cells", () => {
  const base = terminal(authorized(), "not_configured").snapshot();
  const cells = Array.from({ length: 10_000 }, (_, offset) => {
    const sequence = offset + 1; const cell = structuredClone(base.cells[0]!) as any;
    cell.sequence = sequence; cell.receipt.receipt_id = `world-act-${sequence}`;
    cell.receipt.decision_id = `decision-${String(sequence).padStart(12, "0")}`;
    cell.record.receipt_id = cell.receipt.receipt_id; cell.record.decision_id = cell.receipt.decision_id;
    cell.record.dynamics_sequence = sequence; cell.terminal.receipt_id = cell.receipt.receipt_id;
    cell.terminal.decision_id = cell.receipt.decision_id; cell.terminal.sequence = sequence;
    return cell;
  });
  const candidate = { ...base, lanes: [{ principal: "p", count: 10_000 }],
    audits: Array.from({ length: 10_000 }, () => ({ principal: "p", result: "queued" as const })), cells };
  const restored = createWorldActionJournal(); restored.restore(candidate);
  const snapshot = restored.snapshot();
  assert.equal(snapshot.cells.length, 10_000);
  assert.equal(snapshot.cells.every((cell) => cell.state === "terminal" && cell.terminal?.disposition === "applied"), true);
  assert.equal(restored.pending(0).length, 0);
});
