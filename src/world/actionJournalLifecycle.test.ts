import assert from "node:assert/strict";
import test from "node:test";
import { DYNAMICS_LIMITS } from "../dynamics/limits.js";
import { createWorldActionJournal } from "./actionJournal.js";

const identity = { run_id: "run", world_id: "world", world_instance_id: "instance", manifest_digest: `sha256:${"a".repeat(64)}`, state_version: 0 } as const;
const receipt = (sequence: number) => ({ disposition: "queued" as const, receipt_id: `world-act-${sequence}`, decision_id: `decision-${String(sequence).padStart(12, "0")}`, identity, apply_tick: 0 });
const queued = (sequence: number, changes: Record<string, unknown> = {}) => ({
  receipt_id: `world-act-${sequence}`, decision_id: `decision-${String(sequence).padStart(12, "0")}`, principal: "p",
  holder: "world://world/entity/p", affordance: "world://world/affordance/a", target: "world://world/entity/p",
  at_tick: 0, dynamics_sequence: sequence, mechanics_action: "action", mechanics_actor: "object:p", mechanics_target: "object:p",
  lowered_input: {}, identity, ...changes,
});

const reserved = (principals: readonly string[] = ["p"]) => {
  const journal = createWorldActionJournal();
  journal.reservePrincipals(principals);
  return journal;
};
const authorized = (journal: ReturnType<typeof reserved>, sequence: number): void => {
  journal.audit("p", "queued");
  const cell = journal.reserve(receipt(sequence), sequence);
  cell.persist(queued(sequence));
  cell.prepareAuthorization();
  cell.authorize();
};
const terminal = (sequence: number) => Object.freeze({
  disposition: "applied" as const, receipt_id: `world-act-${sequence}`,
  decision_id: `decision-${String(sequence).padStart(12, "0")}`,
  sequence, apply_tick: 0, projection: "not_configured" as const,
});

test("requires reserved, provisional, prepared, then authorized in order", () => {
  const journal = reserved();
  const cell = journal.reserve(receipt(1), 1);
  assert.throws(() => cell.authorize());
  assert.throws(() => journal.snapshot());
  cell.persist(queued(1));
  assert.throws(() => cell.authorize());
  assert.throws(() => journal.snapshot());
  cell.prepareAuthorization();
  assert.throws(() => journal.snapshot());
  assert.doesNotThrow(() => cell.authorize());
  assert.equal(journal.pending(0).length, 1);
  assert.throws(() => cell.authorize());
  assert.throws(() => cell.abort());
});

test("abort is exact from every pre-authorized state and leaves no cell", () => {
  for (const state of ["reserved", "provisional", "prepared"] as const) {
    const journal = reserved();
    const cell = journal.reserve(receipt(1), 1);
    if (state !== "reserved") cell.persist(queued(1));
    if (state === "prepared") cell.prepareAuthorization();
    assert.doesNotThrow(() => cell.abort());
    assert.equal(journal.snapshot().cells.length, 0);
    assert.throws(() => cell.abort());
    assert.throws(() => cell.authorize());
  }
});

test("invalid receipts and every queued field reject without closing or retaining payload", () => {
  const invalidReceipts = [
    undefined, {}, { ...receipt(1), disposition: "bad" }, { ...receipt(1), receipt_id: "other" },
    { ...receipt(1), decision_id: "other" }, { ...receipt(1), apply_tick: -1 },
    { ...receipt(1), identity: { ...identity, manifest_digest: "bad" } },
  ];
  for (const input of invalidReceipts) {
    const journal = reserved();
    assert.throws(() => journal.reserve(input as never, 1));
    assert.equal(journal.snapshot().cells.length, 0);
    journal.audit("p", "denied");
  }

  const invalidRecords = [
    ["receipt_id", "world-act-2"], ["decision_id", "decision-000000000002"], ["principal", "unknown"],
    ["holder", "not-an-address"], ["affordance", "not-an-address"], ["target", "not-an-address"],
    ["at_tick", 1], ["dynamics_sequence", 2], ["mechanics_action", ""], ["mechanics_actor", ""],
    ["mechanics_target", ""], ["lowered_input", []], ["identity", { ...identity, world_id: "other" }],
  ] as const;
  for (const [field, value] of invalidRecords) {
    const journal = reserved();
    const cell = journal.reserve(receipt(1), 1);
    assert.throws(() => cell.persist(queued(1, { [field]: value })));
    assert.throws(() => journal.snapshot());
    cell.abort();
    assert.equal(journal.snapshot().cells.length, 0);
  }
});

test("unknown principals do not allocate, while collisions and exhaustion close deterministically", () => {
  const journal = reserved(["p", "q"]);
  assert.throws(() => journal.reserveAudit("unknown"));
  journal.audit("p", "denied");
  assert.equal(journal.snapshot().audits.length, 1);

  const receiptCollision = reserved();
  receiptCollision.reserve(receipt(1), 1);
  assert.throws(() => receiptCollision.reserve(receipt(1), 2));
  assert.throws(() => receiptCollision.reserve(receipt(2), 3));

  const sequenceCollision = reserved();
  sequenceCollision.reserve(receipt(1), 1);
  assert.throws(() => sequenceCollision.reserve(receipt(2), 1));

  const laneExhaustion = reserved();
  for (let index = 0; index < DYNAMICS_LIMITS.retained_action_records; index += 1) laneExhaustion.audit("p", "denied");
  assert.throws(() => laneExhaustion.reserveAudit("p"));
  const globalExhaustion = reserved(["p", "q"]);
  for (let index = 0; index < DYNAMICS_LIMITS.retained_action_records / 2; index += 1) {
    globalExhaustion.audit("p", "denied");
    globalExhaustion.audit("q", "denied");
  }
  assert.throws(() => globalExhaustion.reserveAudit("p"));

  const cells = reserved();
  for (let sequence = 1; sequence <= DYNAMICS_LIMITS.retained_action_records; sequence += 1) {
    const cell = cells.reserve(receipt(sequence), sequence);
    cell.persist(queued(sequence));
    cell.prepareAuthorization();
    cell.authorize();
  }
  assert.throws(() => cells.reserve(receipt(DYNAMICS_LIMITS.retained_action_records + 1), DYNAMICS_LIMITS.retained_action_records + 1));
  assert.throws(() => cells.reserveAudit("p"));
});

test("closed journals reject new reservations and retain a stable closed snapshot", () => {
  const journal = reserved();
  journal.close();
  assert.throws(() => journal.reserveAudit("p"));
  assert.throws(() => journal.reserve(receipt(1), 1));
  assert.deepEqual(journal.snapshot(), { version: "simfile.world-action-journal.v1", closed: true, lanes: [{ principal: "p", count: 0 }], audits: [], cells: [] });
});

test("binds cloned ordered terminal batches and aborts only without terminal facts", () => {
  const journal = reserved();
  authorized(journal, 2); authorized(journal, 1);
  const batch = journal.reserveTerminals(0);
  assert.deepEqual(batch.queued.map((entry) => entry.dynamics_sequence), [1, 2]);
  assert(Object.isFrozen(batch.queued)); assert(Object.isFrozen(batch.queued[0]!));
  assert.throws(() => journal.pending(0)); assert.throws(() => journal.snapshot());
  batch.abort();
  assert.equal(journal.pending(0).length, 2);
  assert.equal(journal.snapshot().cells.every((cell) => cell.terminal === null), true);
  assert.throws(() => batch.abort());
});

test("commits terminal batches all-or-nothing and closes impossible joins", () => {
  for (const records of [
    [terminal(1)], [terminal(1), terminal(1)], [terminal(1), terminal(99)],
    [terminal(1), { ...terminal(2), decision_id: "decision-000000000001" }],
  ]) {
    const journal = reserved(); authorized(journal, 1); authorized(journal, 2);
    const batch = journal.reserveTerminals(0);
    assert.throws(() => batch.commit(records as never));
    assert.throws(() => journal.reserveAudit("p"));
    const snapshot = journal.snapshot();
    assert.equal(snapshot.closed, true);
    assert.deepEqual(snapshot.cells.map((cell) => [cell.state, cell.terminal]), [["authorized", null], ["authorized", null]]);
    assert.throws(() => batch.abort());
    assert.throws(() => batch.commit(records as never));
  }
  const journal = reserved(); authorized(journal, 1); authorized(journal, 2);
  const batch = journal.reserveTerminals(0);
  batch.commit([terminal(2), terminal(1)]);
  assert.deepEqual(journal.snapshot().cells.map((cell) => cell.terminal?.sequence), [1, 2]);
  assert.throws(() => batch.commit([terminal(1), terminal(2)]));
});

test("closing an active terminal reservation releases it and invalidates both handles", () => {
  const journal = reserved(); authorized(journal, 1);
  const batch = journal.reserveTerminals(0);
  journal.close();
  assert.deepEqual(journal.snapshot().cells.map((cell) => [cell.state, cell.terminal]), [["authorized", null]]);
  assert.equal(journal.snapshot().closed, true);
  assert.throws(() => batch.abort());
  assert.throws(() => batch.commit([terminal(1)]));
});
