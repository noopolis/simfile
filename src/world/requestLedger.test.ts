import assert from "node:assert/strict";
import test from "node:test";
import { encodeWorldActEnvelope } from "./actEnvelope.js";
import {
  createWorldRequestLedger,
  type WorldRequestAuthority,
  type WorldRequestLedger,
  type WorldRequestLedgerSnapshot,
} from "./requestLedger.js";
import {
  worldRequestLedgerRecordCodeUnits,
  type WorldRequestLedgerSnapshotRecord,
} from "./requestLedgerSnapshot.js";

const authority: WorldRequestAuthority = Object.freeze({ principal: "principal-red", run_id: "run-1", world_id: "pitch", world_instance_id: "instance-1" });
const identity = Object.freeze({ run_id: authority.run_id, world_id: authority.world_id, world_instance_id: authority.world_instance_id, manifest_digest: `sha256:${"a".repeat(64)}`, state_version: 0 });
const action = (requestId = "request-1", input: unknown = { direction: 1 }) => {
  const bytes = encodeWorldActEnvelope({ request_id: requestId, affordance: "world://pitch/affordance/kick", target: "world://pitch/entity/red", input });
  const receipt = Object.freeze({ disposition: "queued" as const, receipt_id: "world-act-1", decision_id: "decision-000000000001", identity, apply_tick: 0 });
  const queued = Object.freeze({ receipt_id: receipt.receipt_id, decision_id: receipt.decision_id, principal: authority.principal,
    holder: "world://pitch/entity/red", affordance: "world://pitch/affordance/kick", target: "world://pitch/entity/red",
    at_tick: 0, dynamics_sequence: 1, mechanics_action: "kick", mechanics_actor: "object:red", mechanics_target: "object:red",
    lowered_input: Object.freeze({ direction: 1 }), identity });
  return { bytes, receipt, queued };
};
const claim = (ledger: WorldRequestLedger, bytes: Uint8Array, scope = authority) => ledger.beginClaim({ bytes, authority: scope });
const commit = (ledger: WorldRequestLedger, requestId = "request-1", input: unknown = { direction: 1 }) => {
  const value = action(requestId, input); const result = claim(ledger, value.bytes);
  assert.equal(result.kind, "new");
  if (result.kind !== "new") throw new Error("expected reservation");
  result.reservation.prepare({ at_tick: 0, queued_action: value.queued, receipt: value.receipt });
  result.reservation.commit();
  return value;
};
const emptySnapshot = (ledger: WorldRequestLedger): WorldRequestLedgerSnapshot => ledger.snapshot();
const prepare = (ledger: WorldRequestLedger, value: ReturnType<typeof action>) => {
  const result = claim(ledger, value.bytes); assert.equal(result.kind, "new");
  if (result.kind !== "new") throw new Error("expected reservation");
  result.reservation.prepare({ at_tick: 0, queued_action: value.queued, receipt: value.receipt });
  return result.reservation;
};

test("a claim is prepare-before-commit, abortable, and stale handles fail", () => {
  const ledger = createWorldRequestLedger(); const value = action(); const result = claim(ledger, value.bytes);
  assert.equal(result.kind, "new"); if (result.kind !== "new") throw new Error("expected new");
  assert.equal(result.envelope.request_id, "request-1");
  assert.equal(Object.isFrozen(result.envelope), true);
  assert.deepEqual(result.envelope.bytes, Array.from(value.bytes));
  assert.equal(ledger.size, 0); assert.throws(() => ledger.snapshot(), /not quiescent/u);
  result.reservation.prepare({ at_tick: 0, queued_action: value.queued, receipt: value.receipt });
  result.reservation.abort(); assert.equal(ledger.size, 0); assert.deepEqual(ledger.snapshot(), emptySnapshot(ledger));
  assert.throws(() => result.reservation.abort(), /stale/u);
  assert.throws(() => result.reservation.commit(), /stale/u);
  const retry = claim(ledger, value.bytes); assert.equal(retry.kind, "new");
});

test("exact retries replay the first frozen receipt after external clock-like change", () => {
  const ledger = createWorldRequestLedger(); const value = commit(ledger);
  const first = claim(ledger, value.bytes); assert.equal(first.kind, "replay");
  if (first.kind !== "replay") throw new Error("expected replay");
  assert.equal(first.receipt.apply_tick, 0);
  assert.equal(Object.isFrozen(first.receipt), true); assert.equal(Object.isFrozen(first.receipt.identity), true);
  const changedClock = 99; assert.equal(changedClock, 99);
  const second = claim(ledger, value.bytes); assert.equal(second.kind, "replay");
  if (second.kind === "replay") assert.deepEqual(second.receipt, first.receipt);
});

test("closed ledgers replay exact committed claims but reject new and conflicting claims", () => {
  const ledger = createWorldRequestLedger(); const value = commit(ledger); ledger.close();
  const replay = claim(ledger, value.bytes);
  assert.equal(replay.kind, "replay");
  if (replay.kind === "replay") assert.deepEqual(replay.receipt, value.receipt);
  assert.equal(claim(ledger, action("new-after-close").bytes).kind, "conflict");
  assert.equal(claim(ledger, action("request-1", { direction: 2 }).bytes).kind, "conflict");
  assert.equal(ledger.snapshot().record_count, 1);
});

test("changed bytes and every authority component conflict under one id", () => {
  const ledger = createWorldRequestLedger(); const first = commit(ledger); const changed = action("request-1", { direction: 2 });
  assert.equal(claim(ledger, changed.bytes).kind, "conflict");
  for (const key of ["principal", "run_id", "world_id", "world_instance_id"] as const) {
    const scope = { ...authority, [key]: `${authority[key]}-changed` };
    assert.equal(claim(ledger, first.bytes, scope).kind, "conflict");
  }
});

test("concurrent reservations conflict and capacity closes safely", () => {
  const ledger = createWorldRequestLedger({ max_records: 1 }); const value = action();
  const first = claim(ledger, value.bytes); assert.equal(first.kind, "new");
  assert.equal(claim(ledger, value.bytes).kind, "conflict");
  if (first.kind !== "new") throw new Error("expected new");
  first.reservation.abort(); commit(ledger);
  assert.throws(() => claim(ledger, action("request-2").bytes), /capacity/u);
  assert.equal(ledger.closed, true); assert.equal(ledger.snapshot().closed, true);
  assert.throws(() => first.reservation.commit(), /stale/u);
});

test("snapshot restore is exact once, cloned, and continues with a new request", () => {
  const source = createWorldRequestLedger(); const first = commit(source); const snapshot = source.snapshot();
  const target = createWorldRequestLedger(); target.restore(snapshot);
  assert.deepEqual(target.snapshot(), snapshot); assert.notEqual(target.snapshot().records[0], snapshot.records[0]);
  assert.throws(() => target.restore(snapshot), /pristine/u);
  const next = action("request-2"); const result = claim(target, next.bytes); assert.equal(result.kind, "new");
  if (result.kind !== "new") throw new Error("expected new");
  result.reservation.prepare({ at_tick: 1, queued_action: Object.freeze({ ...next.queued, receipt_id: "world-act-2", decision_id: "decision-000000000002", dynamics_sequence: 2, at_tick: 1 }), receipt: Object.freeze({ ...next.receipt, receipt_id: "world-act-2", decision_id: "decision-000000000002", apply_tick: 1 }) });
  result.reservation.commit(); assert.equal(target.size, 2); assert.equal(first.receipt.apply_tick, 0);
});

test("a full retained ledger restores under the default limits and replays", () => {
  const source = createWorldRequestLedger();
  const values = Array.from({ length: 20 }, (_, index) => {
    const requestId = `large-${String(index).padStart(2, "0")}`;
    const input = { payload: "x".repeat(3_500), index };
    const value = action(requestId, input);
    commit(source, requestId, input);
    return value;
  });
  const snapshot = source.snapshot();
  assert.equal(snapshot.record_count, 20);
  assert.equal(snapshot.code_units > 65_536, true);

  const target = createWorldRequestLedger();
  target.restore(snapshot);
  assert.deepEqual(target.snapshot(), snapshot);
  for (const index of [0, 10, 19]) {
    const replay = claim(target, values[index]!.bytes);
    assert.equal(replay.kind, "replay");
    if (replay.kind === "replay") assert.deepEqual(replay.receipt, values[index]!.receipt);
  }
});

test("hostile or inconsistent snapshots leave a pristine target unchanged", () => {
  const source = createWorldRequestLedger(); commit(source); const baseline = source.snapshot();
  const malformed: unknown[] = [
    { ...baseline, version: "other.v1" },
    { ...baseline, record_count: 0 },
    { ...baseline, code_units: baseline.code_units + 1 },
    { ...baseline, records: [{ ...baseline.records[0], request_id: "other" }] },
    { ...baseline, records: [{ ...baseline.records[0], request_bytes: [...baseline.records[0]!.request_bytes, 0] }] },
    { ...baseline, records: [{ ...baseline.records[0], queued_action: { ...baseline.records[0]!.queued_action, target: "world://pitch/entity/blue" } }] },
    { ...baseline, records: [baseline.records[0], baseline.records[0]] },
  ];
  const alias = { ...baseline, records: [] as unknown[] }; alias.records.push(baseline.records[0], baseline.records[0]); malformed.push(alias);
  for (const input of malformed) {
    const target = createWorldRequestLedger(); const before = target.snapshot();
    assert.throws(() => target.restore(input), /invalid|snapshot/u);
    assert.deepEqual(target.snapshot(), before); assert.equal(target.size, 0); assert.equal(target.closed, false);
  }
  const hostile = { ...baseline, records: [{ ...baseline.records[0], authority: { ...baseline.records[0]!.authority, get principal() { throw new Error("accessor"); } } }] };
  const target = createWorldRequestLedger(); assert.throws(() => target.restore(hostile), /invalid|snapshot/u); assert.equal(target.size, 0);
});

test("root and records-array hostile shapes reject without invoking traps", () => {
  const source = createWorldRequestLedger(); commit(source); const baseline = source.snapshot();
  let traps = 0;
  const rootProxy = new Proxy(baseline, {
    get() { traps += 1; throw new Error("trap"); },
    ownKeys() { traps += 1; throw new Error("trap"); },
  });
  const accessorRoot = { ...baseline } as Record<string, unknown>;
  Object.defineProperty(accessorRoot, "records", { enumerable: true, get() { traps += 1; throw new Error("getter"); } });
  const recordProxy = new Proxy(baseline.records, {
    get() { traps += 1; throw new Error("trap"); },
    ownKeys() { traps += 1; throw new Error("trap"); },
  });
  const recordSubclass = [...baseline.records]; Object.setPrototypeOf(recordSubclass, { });
  const sparseRecords = [...baseline.records]; delete sparseRecords[0];
  const extraRecords = [...baseline.records] as unknown[] & { extra?: boolean }; extraRecords.extra = true;
  const malformed: unknown[] = [
    rootProxy,
    accessorRoot,
    { ...baseline, records: recordProxy },
    { ...baseline, records: recordSubclass },
    { ...baseline, records: sparseRecords },
    { ...baseline, records: extraRecords },
    { ...baseline, extra: true },
  ];
  for (const input of malformed) {
    const target = createWorldRequestLedger(); const before = target.snapshot();
    assert.throws(() => target.restore(input), /invalid|snapshot/u);
    assert.deepEqual(target.snapshot(), before);
    assert.equal(target.size, 0); assert.equal(target.closed, false);
  }
  assert.equal(traps, 0);
});

test("prepared units are cumulative and failed capacity close leaves no replay", () => {
  const first = action("a"); const second = action("b");
  const size = (value: ReturnType<typeof action>): number => { const ledger = createWorldRequestLedger(); commit(ledger, value.bytes ? value === first ? "a" : "b" : "x"); return ledger.snapshot().code_units; };
  const cap = Math.max(size(first), size(second)); const ledger = createWorldRequestLedger({ max_code_units: cap });
  const one = prepare(ledger, first); assert.throws(() => prepare(ledger, second), /capacity/u);
  assert.equal(ledger.closed, true); assert.equal(ledger.size, 0); assert.deepEqual(ledger.snapshot().records, []);
  assert.throws(() => one.commit(), /stale/u); assert.equal(claim(ledger, first.bytes).kind, "conflict");
});

test("distinct prepared requests commit in either order within the cumulative cap", () => {
  for (const reverse of [false, true]) {
    const first = action("order-a"); const second = action("order-b");
    const sizing = createWorldRequestLedger(); commit(sizing, "order-a"); const cap = sizing.snapshot().code_units * 2;
    const ledger = createWorldRequestLedger({ max_code_units: cap }); const left = prepare(ledger, first); const right = prepare(ledger, second);
    (reverse ? right : left).commit(); (reverse ? left : right).commit(); assert.equal(ledger.size, 2); assert.equal(ledger.snapshot().code_units <= cap, true);
  }
});

test("abort releases prepared units and explicit close makes all handles stale", () => {
  const ledger = createWorldRequestLedger(); const first = prepare(ledger, action("abort-a")); first.abort();
  const later = prepare(ledger, action("abort-b")); later.commit(); assert.equal(ledger.size, 1);
  const unprepared = claim(ledger, action("close-a").bytes); assert.equal(unprepared.kind, "new");
  if (unprepared.kind !== "new") throw new Error("expected reservation");
  const prepared = prepare(ledger, action("close-b")); ledger.close();
  assert.equal(ledger.snapshot().closed, true); assert.equal(ledger.snapshot().record_count, 1);
  assert.throws(() => unprepared.reservation.abort(), /stale/u); assert.throws(() => prepared.commit(), /stale/u);
  assert.equal(claim(ledger, action("close-c").bytes).kind, "conflict");
});

test("reservation lifecycle rejects double prepare, premature commit, double commit, and late abort", () => {
  const ledger = createWorldRequestLedger(); const value = action("lifecycle"); const result = claim(ledger, value.bytes);
  assert.equal(result.kind, "new"); if (result.kind !== "new") throw new Error("expected reservation");
  assert.throws(() => result.reservation.commit(), /invalid/u);
  result.reservation.prepare({ at_tick: 0, queued_action: value.queued, receipt: value.receipt });
  assert.throws(() => result.reservation.prepare({ at_tick: 0, queued_action: value.queued, receipt: value.receipt }), /invalid/u);
  result.reservation.commit(); assert.throws(() => result.reservation.commit(), /invalid/u); assert.throws(() => result.reservation.abort(), /stale/u);
});

test("reordered records reject before restore changes the pristine target", () => {
  const source = createWorldRequestLedger(); commit(source, "order-a"); commit(source, "order-b");
  const snapshot = source.snapshot(); const target = createWorldRequestLedger();
  assert.throws(() => target.restore({ ...snapshot, records: [...snapshot.records].reverse() }), /invalid/u);
  assert.deepEqual(target.snapshot(), { version: snapshot.version, closed: false, record_count: 0, code_units: 0, records: [] });
});

test("snapshot relationships and claimed bytes are immutable identities", () => {
  const ledger = createWorldRequestLedger(); const value = action("identity"); const reservation = prepare(ledger, value);
  const retained = [...reservation.request_bytes]; value.bytes[0] ^= 1; reservation.commit();
  assert.equal(claim(ledger, Uint8Array.from(retained)).kind, "replay");
  const snapshot = ledger.snapshot(); const record = snapshot.records[0]!;
  const alteredEnvelope = encodeWorldActEnvelope({ request_id: "identity", affordance: "world://pitch/affordance/jump", target: "world://pitch/entity/red", input: { direction: 1 } });
  for (const altered of [
    { ...record, request_bytes: [...alteredEnvelope] },
    { ...record, queued_action: { ...record.queued_action, target: "world://pitch/entity/sun" } },
    { ...record, receipt: { ...record.receipt, identity: { ...record.receipt.identity, state_version: 1 } } },
    { ...record, queued_action: { ...record.queued_action, identity: { ...record.queued_action.identity, state_version: 1 } } },
  ] satisfies WorldRequestLedgerSnapshotRecord[]) {
    const target = createWorldRequestLedger();
    assert.throws(() => target.restore({
      ...snapshot,
      code_units: worldRequestLedgerRecordCodeUnits(altered),
      records: [altered],
    }), /invalid/u);
    assert.equal(target.size, 0);
  }
  const changedLowering = {
    ...record,
    queued_action: { ...record.queued_action, lowered_input: { direction: 22_222 } },
  };
  const target = createWorldRequestLedger();
  assert.throws(() => target.restore({ ...snapshot, records: [changedLowering] }), /invalid/u);
  assert.equal(target.size, 0);
});
