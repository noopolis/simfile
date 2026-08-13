import assert from "node:assert/strict";
import test from "node:test";

import { DYNAMICS_LIMITS } from "../dynamics/limits.js";
import { WORLD_ACTION_RESULT_VERSION, parseWorldActionResult } from "./actionResult.js";
import { createWorldActionResultLedger, parseWorldActionResultPageRequest, readWorldActionResultLedger, WORLD_ACTION_RESULT_CURSOR_VERSION, WORLD_ACTION_RESULT_PAGE_REQUEST_VERSION } from "./actionResultLedger.js";
import { createWorldReadLedger } from "./ledger.js";
import * as world from "./index.js";

const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const red = Object.freeze({ principal: "red", actor: "world://world/entity/red", run_id: "run", world_id: "world", world_instance_id: "instance", manifest_digest: digest("a") });
const blue = Object.freeze({ principal: "blue", actor: "world://world/entity/blue", run_id: "run", world_id: "world", world_instance_id: "instance", manifest_digest: digest("b") });
const result = (principal: typeof red | typeof blue, action = 1, decision = 17) => ({ version: WORLD_ACTION_RESULT_VERSION, result_id: `world-result-${action + 100}`, receipt_id: `world-act-${action}`, decision_id: `decision-${String(decision).padStart(12, "0")}`, actor: principal.actor, action_sequence: action, apply_tick: 3, status: "applied" as const, caused_effect_ids: [`world-effect-${action}`], identity: { run_id: principal.run_id, world_id: principal.world_id, world_instance_id: principal.world_instance_id, manifest_digest: principal.manifest_digest, state_version: 3 } });
const rejected = (principal: typeof red | typeof blue, action: number, decision: number, rejection_code = "world_action_rejected") => { const { caused_effect_ids: _effects, ...base } = result(principal, action, decision); return { ...base, status: "rejected_at_mechanics" as const, rejection_code }; };
const authority = (ledger: ReturnType<typeof createWorldActionResultLedger>) => readWorldActionResultLedger(ledger)!;
const reserve = (ledger: ReturnType<typeof createWorldActionResultLedger>, bindings: readonly unknown[] = [red, blue]) => authority(ledger).reserve({ bindings });
const request = (overrides: Record<string, unknown> = {}) => ({ version: WORLD_ACTION_RESULT_PAGE_REQUEST_VERSION, ...overrides });

test("parses frozen canonical results with independent decision issuance and bounded effects", () => {
  const parsed = parseWorldActionResult(result(red, 1, 17))!;
  assert.ok(Object.isFrozen(parsed)); assert.equal(parsed.decision_id, "decision-000000000017");
  if (parsed.status !== "applied") throw new Error("expected applied");
  assert.ok(Object.isFrozen(parsed.caused_effect_ids)); assert.throws(() => (parsed.caused_effect_ids as string[]).push("x"), TypeError);
  const ceiling = { ...result(red), caused_effect_ids: Array.from({ length: DYNAMICS_LIMITS.events_per_tick }, (_, index) => `world-effect-${index + 1}`) };
  assert.ok(parseWorldActionResult(ceiling));
  assert.equal(parseWorldActionResult({ ...ceiling, caused_effect_ids: [...ceiling.caused_effect_ids, "world-effect-999"] }), undefined);
  for (const value of [{ ...result(red), actor: "red" }, { ...result(red), actor: "world://other/entity/red" }, { ...result(red), receipt_id: "world-act-9" }, { ...result(red), decision_id: "decision-x" }, { ...result(red), decision_id: "decision-000000000000" }, { ...result(red), result_id: "world-result-9007199254740992" }, { ...result(red), caused_effect_ids: ["world-effect-1", "world-effect-1"] }, { ...result(red), rejection_code: "world_action_rejected" }, { ...rejected(red, 1, 17), caused_effect_ids: [] }]) assert.equal(parseWorldActionResult(value), undefined);
});

test("parsers reject hostile fields without coercion or foreign evaluation", () => {
  let called = 0; const accessor = { ...result(red) } as Record<string, unknown>;
  Object.defineProperty(accessor, "actor", { enumerable: true, get: () => { called += 1; return red.actor; } });
  assert.equal(parseWorldActionResult(accessor), undefined); assert.equal(called, 0);
  const ledger = createWorldActionResultLedger(); reserve(ledger); const writer = authority(ledger); writer.append({ principal: "red", result: result(red) }); const cursor = ledger.read("red", request()).next_result_after!;
  const hostile = (field: "issuer" | "proof") => ({ ...cursor, [field]: Symbol(field) });
  for (const cursorValue of [hostile("issuer"), hostile("proof"), { ...cursor, issuer: {} }, { ...cursor, proof: {} }, new Proxy(cursor, { getPrototypeOf: () => { called += 1; throw new Error("trap"); } })]) {
    assert.equal(parseWorldActionResultPageRequest(request({ result_after: cursorValue })), undefined);
    assert.throws(() => ledger.read("red", request({ result_after: cursorValue })), /World runtime request denied/u);
  }
  assert.equal(called, 0);
});

test("keeps the public request authority-free and pages only issued result cursors", () => {
  const ledger = createWorldActionResultLedger(); reserve(ledger); const writer = authority(ledger); writer.append({ principal: "red", result: result(red) });
  const page = ledger.read("red", request()); assert.equal(page.results.length, 1); assert.equal(page.next_result_after?.version, WORLD_ACTION_RESULT_CURSOR_VERSION);
  for (const input of [request({ identity: {} }), request({ principal: "red" }), request({ state_version: 3 }), request({ limit: 101 }), request({ result_after: 1 })]) assert.equal(parseWorldActionResultPageRequest(input), undefined);
  assert.equal("records" in page, false); assert.equal("next_cursor" in page, false); assert.equal("createWorldActionResultLedger" in world, false); assert.equal("readWorldActionResultLedger" in world, false);
});

test("binds each append and cursor to its exact host reservation", () => {
  const source = createWorldActionResultLedger(); const other = createWorldActionResultLedger(); reserve(source); reserve(other); const writer = authority(source);
  writer.append({ principal: "red", result: result(red, 1, 17) }); writer.append({ principal: "blue", result: result(blue, 2, 18) });
  const cursor = JSON.parse(JSON.stringify(source.read("red", request()).next_result_after));
  assert.throws(() => other.read("red", request({ result_after: cursor })), /denied/u);
  assert.throws(() => source.read("blue", request({ result_after: cursor })), /denied/u);
  assert.throws(() => writer.append({ principal: "blue", result: result(red, 3, 19) }), /construction/u);
  assert.throws(() => writer.append({ principal: "red", result: { ...result(red, 3, 19), actor: blue.actor } }), /construction/u);
  assert.throws(() => writer.append({ principal: "red", result: { ...result(red, 3, 19), actor: "world://other/entity/red" } }), /construction/u);
  assert.throws(() => writer.append({ principal: "red", result: { ...result(red, 3, 19), identity: { ...result(red, 3, 19).identity, manifest_digest: blue.manifest_digest } } }), /construction/u);
});

test("rejects cross-world actors at every public and host boundary", () => {
  const foreign = { ...red, actor: "world://other/entity/red" };
  assert.equal(parseWorldActionResult(result(foreign as typeof red)), undefined);
  const ledger = createWorldActionResultLedger(); const writer = authority(ledger);
  assert.throws(() => reserve(ledger, [foreign]), /construction/u);
  reserve(ledger); writer.append({ principal: "red", result: result(red, 1, 17) });
  const cursor = ledger.read("red", request()).next_result_after!;
  assert.throws(() => ledger.read("red", request({ result_after: { ...cursor, world_id: "other" } })), /denied/u);
});

test("uses principal paging sequences and fails only after an unseen same-principal eviction", () => {
  const ledger = createWorldActionResultLedger({ maxEntriesPerPrincipal: 1 }); reserve(ledger); const writer = authority(ledger);
  writer.append({ principal: "red", result: result(red, 1, 17) }); const seenRedOne = ledger.read("red", request()).next_result_after!;
  writer.append({ principal: "blue", result: result(blue, 2, 18) }); writer.append({ principal: "red", result: result(red, 3, 19) });
  const afterSeen = ledger.read("red", request({ result_after: seenRedOne })); assert.equal(afterSeen.results[0]?.receipt_id, "world-act-3");
  writer.append({ principal: "red", result: result(red, 4, 20) }); assert.throws(() => ledger.read("red", request({ result_after: seenRedOne })), /denied/u);
  const empty = ledger.read("blue", request({ result_after: ledger.read("blue", request()).next_result_after }));
  assert.equal(empty.results.length, 0); assert.deepEqual(empty.next_result_after, ledger.read("blue", request({ result_after: empty.next_result_after })).next_result_after);
});

test("enforces globally bounded exact-once terminal admission and declared rejection codes", () => {
  const ledger = createWorldActionResultLedger(); reserve(ledger); const writer = authority(ledger); writer.append({ principal: "red", result: rejected(red, 1, 17, "declared"), declared_rejection_codes: ["declared"] });
  for (const duplicate of [{ ...result(blue, 2, 18), result_id: "world-result-101" }, { ...result(blue, 2, 18), receipt_id: "world-act-1" }, { ...result(blue, 2, 17) }]) assert.throws(() => writer.append({ principal: "blue", result: duplicate }), /construction/u);
  assert.throws(() => writer.append({ principal: "blue", result: rejected(blue, 2, 18, "undeclared") }), /construction/u);
  const audit = createWorldReadLedger(); assert.throws(() => audit.read("red", { after: ledger.read("red", request()).next_result_after as unknown as number }));
});

test("freezes cloned values and rejects hostile result, binding, request, and option sources", () => {
  const parsed = parseWorldActionResult(result(red))!;
  assert.ok(Object.isFrozen(parsed.identity)); assert.throws(() => (parsed.identity as { state_version: number }).state_version = 9, TypeError);
  const mutable = result(red, 1, 17); const ledger = createWorldActionResultLedger(); reserve(ledger); authority(ledger).append({ principal: "red", result: mutable });
  mutable.identity.state_version = 99; mutable.caused_effect_ids[0] = "world-effect-99";
  const page = ledger.read("red", request()); assert.ok(Object.isFrozen(page)); assert.ok(Object.isFrozen(page.results)); assert.ok(Object.isFrozen(page.results[0]));
  assert.equal(page.results[0]!.identity.state_version, 3); assert.equal((page.results[0] as typeof parsed & { caused_effect_ids: readonly string[] }).caused_effect_ids[0], "world-effect-1");
  const cursor = page.next_result_after!; const parsedRequest = parseWorldActionResultPageRequest(request({ result_after: cursor }))!;
  assert.ok(Object.isFrozen(parsedRequest)); assert.ok(Object.isFrozen(parsedRequest.result_after)); assert.ok(Object.isFrozen(cursor));
  const cycle: Record<string, unknown> = { ...result(red) }; cycle.self = cycle;
  const sparse = ["world-effect-1"] as string[]; sparse.length = 2;
  const thenable = { ...result(red), then: () => undefined }; const prototypeThenable = Object.create({ then: () => undefined }); Object.assign(prototypeThenable, result(red));
  const inherited = Object.create(result(red)); const accessor = { ...result(red) }; Object.defineProperty(accessor, "actor", { enumerable: true, get: () => red.actor });
  const exotic = ["world-effect-1"]; Object.setPrototypeOf(exotic, null);
  for (const hostile of [cycle, { ...result(red), caused_effect_ids: sparse }, { ...result(red), caused_effect_ids: exotic }, { ...result(red), actor: Symbol("actor") }, thenable, prototypeThenable, inherited, accessor, new Proxy(result(red), {})]) assert.equal(parseWorldActionResult(hostile), undefined);
  const binding = { ...red, actor: "world://other/entity/red" }; const hostileOptions = new Proxy({}, {});
  assert.throws(() => createWorldActionResultLedger(hostileOptions), /construction/u); assert.throws(() => authority(createWorldActionResultLedger()).reserve({ bindings: [binding] }), /construction/u);
  const bindingProxy = new Proxy(red, {}); assert.throws(() => authority(createWorldActionResultLedger()).reserve({ bindings: [bindingProxy] }), /construction/u);
  for (const hostile of [{ ...request(), extra: true }, Object.create(request()), { ...request(), result_after: [] }, { ...request(), result_after: Symbol("cursor") }, new Proxy(request(), {})]) assert.equal(parseWorldActionResultPageRequest(hostile), undefined);
});

test("leaves failed reservation, append, and read operations atomic and retryable", () => {
  const ledger = createWorldActionResultLedger({ maxEntriesPerPrincipal: 1 }); const writer = authority(ledger);
  assert.throws(() => writer.reserve({ bindings: [red, red] }), /construction/u); reserve(ledger, [red]);
  assert.throws(() => writer.append({ principal: "red", result: { ...result(red), actor: "world://other/entity/red" } }), /construction/u);
  writer.append({ principal: "red", result: result(red, 1, 17) }); const before = ledger.read("red", request());
  assert.throws(() => ledger.read("red", request({ result_after: { ...before.next_result_after!, proof: "0".repeat(64) } })), /denied/u);
  assert.deepEqual(ledger.read("red", request()), before); assert.equal(ledger.read("red", request({ result_after: before.next_result_after })).results.length, 0);
});

test("keeps all host construction and authority seams out of the public barrel", () => {
  for (const name of ["createWorldActionResultLedger", "readWorldActionResultLedger", "parseWorldActionResultPageRequest", "WORLD_ACTION_RESULT_CURSOR_VERSION", "WORLD_ACTION_RESULT_PAGE_REQUEST_VERSION", "reservation", "snapshot", "restore", "journal", "requestLedger", "clockAuthority", "inspection"]) assert.equal(name in world, false);
});
