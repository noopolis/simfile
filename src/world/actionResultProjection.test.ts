import assert from "node:assert/strict";
import test from "node:test";

import { createWorldActionResultLedger, readWorldActionResultLedger } from "./actionResultLedger.js";
import { prepareWorldActionResults } from "./actionResultProjection.js";

const identity = Object.freeze({ run_id: "run", world_id: "world", world_instance_id: "instance", manifest_digest: `sha256:${"a".repeat(64)}`, state_version: 7 });
const binding = Object.freeze({ principal: "p", actor: "world://world/entity/p", run_id: "run", world_id: "world", world_instance_id: "instance", manifest_digest: identity.manifest_digest });
const blueIdentity = Object.freeze({ ...identity, manifest_digest: `sha256:${"b".repeat(64)}` });
const blueBinding = Object.freeze({ ...binding, principal: "blue", actor: "world://world/entity/blue", manifest_digest: blueIdentity.manifest_digest });
const action = (sequence: number, principal = "p", actionIdentity = identity, holder = principal === "p" ? binding.actor : blueBinding.actor) => Object.freeze({ receipt_id: `world-act-${sequence}`, decision_id: `decision-${String(sequence).padStart(12, "0")}`, principal, holder, affordance: "world://world/affordance/kick", target: holder, at_tick: 4, dynamics_sequence: sequence, mechanics_action: "kick", mechanics_actor: `object:${principal}`, mechanics_target: `object:${principal}`, lowered_input: Object.freeze({}), identity: { ...actionIdentity, state_version: 1 } });
const terminal = (sequence: number, disposition: "applied" | "rejected_at_mechanics", code?: string) => Object.freeze({ disposition, receipt_id: `world-act-${sequence}`, decision_id: `decision-${String(sequence).padStart(12, "0")}`, sequence, apply_tick: 4, projection: "not_configured" as const, ...(code === undefined ? {} : { public_code: code }) });
const event = (causes: number[], sequence = 99) => ({ cause_action_sequences: causes, kind: "impact", payload: { n: 1 }, source: "private", target: "private", event_sequence: sequence, provenance: "mechanical" as const, tick: 4 });
const registry = { projectEffect: (_kind: string, _payload: unknown) => Object.freeze({ effect: "effect:impact", payload: {} }) };
const reservation = (actions: readonly ReturnType<typeof action>[], effects = 256, codes: readonly string[] = [], bindings: readonly { readonly principal: string; readonly actor: string; readonly run_id: string; readonly world_id: string; readonly world_instance_id: string; readonly manifest_digest: string }[] = [binding]) => { const ledger = createWorldActionResultLedger(); const authority = readWorldActionResultLedger(ledger)!; authority.reserve({ bindings }); const batch = () => authority.reserveBatch({ actions: actions.map((item) => ({ principal: item.principal, receipt_id: item.receipt_id, decision_id: item.decision_id, action_sequence: item.dynamics_sequence, declared_rejection_codes: codes })), effect_capacity: effects }); return { ledger, batch: batch(), retry: batch }; };

test("projects ordered shared effects with ledger-issued ids and post-step identity", () => {
  const pending = [action(99), action(100)], issued = reservation(pending);
  const results = prepareWorldActionResults({ pending, terminals: [terminal(99, "applied"), terminal(100, "applied")], events: [event([99, 100]), event([100], 1000)], postMechanicsStateVersion: 5, registry: registry as never, reservation: issued.batch });
  assert.deepEqual(results.map((result) => result.result_id), ["world-result-1", "world-result-2"]);
  assert.deepEqual((results[0] as { caused_effect_ids: readonly string[] }).caused_effect_ids, ["world-effect-1"]);
  assert.deepEqual((results[1] as { caused_effect_ids: readonly string[] }).caused_effect_ids, ["world-effect-1", "world-effect-2"]);
  assert.equal(results[0]!.identity.state_version, 5); assert.equal(issued.ledger.read("p", { version: "simfile.world-action-result-page-request.v1" }).results.length, 2);
});

test("keeps red and blue identities distinct in one globally ordered shared-event batch", () => {
  const pending = [action(1, "p", identity), action(2, "blue", blueIdentity)], issued = reservation(pending, 1, [], [binding, blueBinding]);
  const results = prepareWorldActionResults({ pending, terminals: [terminal(1, "applied"), terminal(2, "applied")], events: [event([1, 2])], postMechanicsStateVersion: 5, registry: registry as never, reservation: issued.batch });
  assert.deepEqual(results.map((result) => result.action_sequence), [1, 2]);
  assert.equal(results[0]!.identity.manifest_digest, identity.manifest_digest); assert.equal(results[1]!.identity.manifest_digest, blueIdentity.manifest_digest);
  assert.deepEqual(results.map((result) => result.identity.state_version), [5, 5]);
  assert.deepEqual((results[0] as { caused_effect_ids: readonly string[] }).caused_effect_ids, ["world-effect-1"]);
  assert.deepEqual((results[1] as { caused_effect_ids: readonly string[] }).caused_effect_ids, ["world-effect-1"]);
});

test("accepts cross-action event order while preserving each public result order", () => {
  const pending = [action(1), action(2)], issued = reservation(pending, 2);
  const results = prepareWorldActionResults({ pending, terminals: [terminal(1, "applied"), terminal(2, "applied")], events: [event([2], 1), event([1, 2], 2)], postMechanicsStateVersion: 5, registry: registry as never, reservation: issued.batch });
  assert.deepEqual((results[0] as { caused_effect_ids: readonly string[] }).caused_effect_ids, ["world-effect-2"]);
  assert.deepEqual((results[1] as { caused_effect_ids: readonly string[] }).caused_effect_ids, ["world-effect-1", "world-effect-2"]);
});

test("aborts projection failures with no admission or counter gap and rejects current rejected causes", () => {
  const pending = [action(1)], issued = reservation(pending, 1);
  assert.throws(() => prepareWorldActionResults({ pending, terminals: [terminal(1, "applied")], events: [event([1])], postMechanicsStateVersion: 5, registry: { projectEffect: () => { throw new Error("undeclared"); } } as never, reservation: issued.batch }), /undeclared/u);
  const results = prepareWorldActionResults({ pending: [action(1)], terminals: [terminal(1, "applied")], events: [], postMechanicsStateVersion: 5, registry: registry as never, reservation: issued.retry() });
  assert.equal(results[0]!.result_id, "world-result-1");
  const rejected = reservation([action(2)]); assert.throws(() => prepareWorldActionResults({ pending: [action(2)], terminals: [terminal(2, "rejected_at_mechanics", "blocked")], events: [event([2])], postMechanicsStateVersion: 5, registry: registry as never, reservation: rejected.batch }), /rejected/u);
});

test("publishes declared mechanics rejection and ignores prior or causeless events", () => {
  const rejected = reservation([action(900_000)], 0, ["blocked"]);
  const values = prepareWorldActionResults({ pending: [action(900_000)], terminals: [terminal(900_000, "rejected_at_mechanics", "blocked")], events: [], postMechanicsStateVersion: 5, registry: registry as never, reservation: rejected.batch });
  assert.equal(values[0]!.result_id, "world-result-1"); assert.equal(values[0]!.status, "rejected_at_mechanics");
  const applied = reservation([action(900_001)]);
  const result = prepareWorldActionResults({ pending: [action(900_001)], terminals: [terminal(900_001, "applied")], events: [event([1]), event([]), event([900_001], 2)], postMechanicsStateVersion: 5, registry: registry as never, reservation: applied.batch });
  assert.deepEqual((result[0] as { caused_effect_ids: readonly string[] }).caused_effect_ids, ["world-effect-1"]);
});

test("detaches queued action identity before constructing results and rejects foreign identity", () => {
  const originalManifest = identity.manifest_digest;
  const mutable: { run_id: string; world_id: string; world_instance_id: string; manifest_digest: string; state_version: number } = { ...identity };
  const pending = [{ ...action(1), identity: mutable as ReturnType<typeof action>["identity"] }];
  const issued = reservation(pending);
  assert.equal(mutable.manifest_digest, originalManifest);
  const values = prepareWorldActionResults({ pending, terminals: [terminal(1, "applied")], events: [], postMechanicsStateVersion: 5, registry: registry as never, reservation: issued.batch });
  mutable.manifest_digest = `sha256:${"c".repeat(64)}`;
  const stored = issued.ledger.read("p", { version: "simfile.world-action-result-page-request.v1" }).results[0]!;
  assert.ok(Object.isFrozen(values[0]!.identity)); assert.ok(Object.isFrozen(stored.identity));
  assert.equal(values[0]!.identity.manifest_digest, originalManifest); assert.equal(stored.identity.manifest_digest, originalManifest);
  assert.equal(values[0]!.identity.state_version, 5); assert.equal(stored.identity.state_version, 5);
  const global = reservation([action(2)]); const withGlobalDigest = { pending: [action(2)], terminals: [terminal(2, "applied")], events: [], postMechanicsStateVersion: 5, identity: blueIdentity, registry: registry as never, reservation: global.batch };
  const globalResults = prepareWorldActionResults(withGlobalDigest as never); assert.equal(globalResults[0]!.identity.manifest_digest, identity.manifest_digest);
});

test("rejects every substituted queued-action identity field atomically", () => {
  const substitutions = [
    ["run_id", "other-run"], ["world_id", "other-world"], ["world_instance_id", "other-instance"],
    ["manifest_digest", `sha256:${"b".repeat(64)}`],
  ] as const;
  for (const [field, value] of substitutions) {
    const substituted = { ...identity, [field]: value };
    const pending = [action(1, "p", substituted)], issued = reservation(pending);
    assert.throws(() => prepareWorldActionResults({ pending, terminals: [terminal(1, "applied")], events: [], postMechanicsStateVersion: 5, registry: registry as never, reservation: issued.batch }), field);
    assert.equal(issued.ledger.read("p", { version: "simfile.world-action-result-page-request.v1" }).results.length, 0);
    const retry = issued.retry();
    assert.equal(retry.resultId(0), "world-result-1"); assert.equal(retry.effectId(0), "world-effect-1");
    retry.abort();
  }
});

test("rejects hostile queued-action identities without executing callbacks", () => {
  type HostileCase = { readonly hostile: object; readonly value: number };
  const cases: readonly [string, () => HostileCase][] = [
    ["accessor", () => { let value = 0; const hostile = { ...identity }; Object.defineProperty(hostile, "run_id", { enumerable: true, get: () => { value += 1; return identity.run_id; } }); return { hostile, get value() { return value; } }; }],
    ["proxy", () => { let value = 0; const target = { ...identity }; const hostile = new Proxy(target, { get: () => { value += 1; return identity.run_id; }, ownKeys: () => { value += 1; return Reflect.ownKeys(target); }, getOwnPropertyDescriptor: () => { value += 1; return undefined; } }); return { hostile, get value() { return value; } }; }],
  ];
  for (const [name, make] of cases) {
    const hostile = make(), pending = [{ ...action(1), identity: hostile.hostile as never }], issued = reservation(pending as never);
    assert.throws(() => prepareWorldActionResults({ pending: pending as never, terminals: [terminal(1, "applied")], events: [], postMechanicsStateVersion: 5, registry: registry as never, reservation: issued.batch }), name);
    assert.equal(hostile.value, 0); assert.equal(issued.ledger.read("p", { version: "simfile.world-action-result-page-request.v1" }).results.length, 0);
    const retry = issued.retry();
    assert.equal(retry.resultId(0), "world-result-1"); assert.equal(retry.effectId(0), "world-effect-1");
    retry.abort();
  }
});

test("rejects unsafe post-state versions, tick mismatches, mixed ticks, and overflow atomically", () => {
  const cases: readonly [string, number, readonly Record<string, unknown>[]][] = [
    ["negative", -1, [terminal(1, "applied")]], ["fractional", 5.5, [terminal(1, "applied")]],
    ["mismatch", 6, [terminal(1, "applied")]], ["mixed", 5, [terminal(1, "applied"), { ...terminal(2, "applied"), apply_tick: 3 }]],
    ["unsafe-version", Number.MAX_SAFE_INTEGER + 1, [terminal(1, "applied")]],
    ["overflow", Number.MAX_SAFE_INTEGER, [{ ...terminal(1, "applied"), apply_tick: Number.MAX_SAFE_INTEGER }],],
  ];
  for (const [name, version, terminals] of cases) {
    const pending = terminals.map((item) => action(item.sequence as number)), issued = reservation(pending);
    assert.throws(() => prepareWorldActionResults({ pending, terminals: terminals as never, events: [], postMechanicsStateVersion: version, registry: registry as never, reservation: issued.batch }), name);
    assert.equal(issued.ledger.read("p", { version: "simfile.world-action-result-page-request.v1" }).results.length, 0);
    const retry = issued.retry();
    assert.equal(retry.resultId(0), "world-result-1");
    assert.equal(retry.effectId(0), "world-effect-1");
    retry.abort();
  }
});

test("batch admission owns declared rejection codes without blocking applications", () => {
  const declared = reservation([action(1)], 0, ["blocked"]), invalid = { ...terminal(1, "rejected_at_mechanics", "undeclared"), public_code: "undeclared" };
  assert.throws(() => prepareWorldActionResults({ pending: [action(1)], terminals: [invalid], events: [], postMechanicsStateVersion: 5, registry: registry as never, reservation: declared.batch }));
  const accepted = declared.retry(); prepareWorldActionResults({ pending: [action(1)], terminals: [terminal(1, "applied")], events: [], postMechanicsStateVersion: 5, registry: registry as never, reservation: accepted });
  assert.equal(declared.ledger.read("p", { version: "simfile.world-action-result-page-request.v1" }).results[0]!.status, "applied");
});
