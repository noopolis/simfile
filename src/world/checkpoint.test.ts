import assert from "node:assert/strict";
import test from "node:test";
import { parseWorldCheckpoint, cloneWorldCheckpoint, WORLD_CHECKPOINT_VERSION, type WorldCheckpoint } from "./checkpoint.js";
import { compileCapabilityManifests } from "./capabilityManifest.js";
import { parseWorldSurfaceDefinition } from "../world-surface/index.js";
import { validWorldSurface } from "../world-surface/definition.test-helper.js";
import * as worldBarrel from "./index.js";
import * as rootBarrel from "../index.js";
import { createWorldActionJournal } from "./actionJournal.js";
import { parseWorldActionJournalSnapshot } from "./actionJournalSnapshot.js";
import { createWorldRequestLedger } from "./requestLedger.js";
import { parseWorldRequestLedgerSnapshot, worldRequestLedgerRecordCodeUnits } from "./requestLedgerSnapshot.js";
import { encodeWorldActEnvelope } from "./actEnvelope.js";
import { createWorldActionResultLedger, readWorldActionResultLedger } from "./actionResultLedger.js";
import { parseWorldActionResultLedgerSnapshot } from "./actionResultLedgerSnapshot.js";
import { digestDynamicsActionAttempt } from "../dynamics/actionRetention.js";

const artifact = "a".repeat(64);
const fingerprint = `sha256:${"b".repeat(64)}`;
const dynamics = () => ({
  version: "simfile.dynamics-snapshot.v1", accepted_action_sequences: { floor: 1, above_floor: [] },
  action_ingress: [], action_ingress_floor: 1, action_ingress_ordinal: 0, next_action_sequence: 1,
  next_event_sequence: 1, next_tick: 0, pending_actions: [], provider_state: {},
  provenance: { api_version: "simfile.dynamics-provider.v1", config_sha256: "c".repeat(64), module: "provider", module_sha256: artifact, node_version: "node", numeric_model: "ieee754-binary64", provider_dependencies: {}, provider_id: "provider:id", provider_version: "1", state_schema_version: "1" },
  resolved_action_sequences: { floor: 1, above_floor: [] }, seed: "seed", sim_seconds_per_tick: 1,
});
const empty = (): Record<string, unknown> => ({
  version: WORLD_CHECKPOINT_VERSION,
  static: { executed_artifact_sha256: artifact, dynamics_build_receipt_sha256: "d".repeat(64), capability_manifests: [] },
  dynamics: dynamics(),
  decisions: { version: "simfile.decision-registry.v1", runId: "run", worldInstanceId: "instance", tokenDigestKeyFingerprint: fingerprint, phase: "open", cutoffTick: null, admissionsClosedTick: null, finalizedTick: null, lastTick: null, nextDecisionSequence: 1, decisions: [] },
  action_journal: { version: "simfile.world-action-journal.v1", closed: false, lanes: [], audits: [], cells: [] },
  request_ledger: { version: "simfile.world-request-ledger.v1", closed: false, record_count: 0, code_units: 0, records: [] },
  action_result_ledger: { version: "simfile.world-action-result-ledger.v1", max_entries: 1, max_principals: 1, issuer: "e".repeat(32), secret: "f".repeat(64), bindings: [], entries: [], pages: [], evicted: [], result_ids: [], receipt_ids: [], decision_ids: [], action_sequences: [], effect_watermarks: [], admitted: 0, previous_action: 0, next_result: 1, next_effect: 1 },
  read_ledger: { version: "simfile.world-read-ledger.v1", max_entries_per_principal: 1, max_principals: 1, lanes: [] },
});
const accepted = (value: unknown): WorldCheckpoint => {
  const parsed = parseWorldCheckpoint(value);
  assert(parsed !== undefined, "positive fixture must be accepted");
  return parsed;
};
const manifestArtifacts = () => compileCapabilityManifests({
  runId: "run-1", worldInstanceId: "instance-1", world: { id: "pitch" as never },
  surfaceRegistry: parseWorldSurfaceDefinition(validWorldSurface()), grants: [{
    participant: "red", principal: "principal-red", entity: "world://pitch/entity/red" as never,
    senses: ["world://pitch/sense/vision" as never], affordances: ["world://pitch/affordance/kick" as never]
  }]
});
const twoManifestArtifacts = (runId = "run-1") => {
  const surface = validWorldSurface() as Record<string, any>;
  surface.entities.blue = { address: "entity:blue", dynamics_address: "object:player.blue" };
  return compileCapabilityManifests({
    runId, worldInstanceId: "instance-1", world: { id: "pitch" as never },
    surfaceRegistry: parseWorldSurfaceDefinition(surface), grants: [
      { participant: "red", principal: "principal-red", entity: "world://pitch/entity/red" as never, senses: ["world://pitch/sense/vision" as never], affordances: ["world://pitch/affordance/kick" as never] },
      { participant: "blue", principal: "principal-blue", entity: "world://pitch/entity/blue" as never, senses: ["world://pitch/sense/vision" as never], affordances: ["world://pitch/affordance/kick" as never] },
    ]
  });
};

const composed = (): Record<string, unknown> => {
  const [manifest] = manifestArtifacts(); const identity = (state_version = 0) => ({ run_id: "run-1", world_id: "pitch", world_instance_id: "instance-1", manifest_digest: manifest.digest, state_version });
  const holder = manifest.manifest.holder.entity, affordanceEntry = manifest.manifest.affordances[0]!, affordance = affordanceEntry.address;
  const target = affordanceEntry.target_selector.kind === "holder" ? holder : affordanceEntry.target_selector.targets[0]!;
  const action = (sequence: number) => { const tick = sequence === 3 ? 1 : 0; return ({ receipt_id: `world-act-${sequence}`, decision_id: `decision-${String(sequence).padStart(12, "0")}`, principal: "principal-red", holder, affordance, target, at_tick: tick, dynamics_sequence: sequence, mechanics_action: "kick", mechanics_actor: "object:player.red", mechanics_target: "object:player.red", lowered_input: {}, identity: identity(tick) }); };
  const receipt = (sequence: number) => { const tick = sequence === 3 ? 1 : 0; return ({ disposition: "queued" as const, receipt_id: `world-act-${sequence}`, decision_id: `decision-${String(sequence).padStart(12, "0")}`, identity: identity(tick), apply_tick: tick }); };
  const journal = createWorldActionJournal(); journal.reservePrincipals(["principal-red"]);
  for (let sequence = 1; sequence <= 3; sequence += 1) { journal.audit("principal-red", "queued"); const cell = journal.reserve(receipt(sequence), sequence); cell.persist(action(sequence)); cell.prepareAuthorization(); cell.authorize(); }
  journal.terminal({ disposition: "applied", receipt_id: "world-act-1", decision_id: "decision-000000000001", sequence: 1, apply_tick: 0, projection: "not_configured" });
  journal.project({ disposition: "applied", receipt_id: "world-act-1", decision_id: "decision-000000000001", sequence: 1, apply_tick: 0, projection: "projected", effect: { projected: true } });
  journal.terminal({ disposition: "rejected_at_mechanics", receipt_id: "world-act-2", decision_id: "decision-000000000002", sequence: 2, apply_tick: 0, projection: "not_configured" });
  const requestLedger = createWorldRequestLedger();
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    const requestId = `request-${sequence}`, bytes = encodeWorldActEnvelope({ request_id: requestId, affordance, target, input: {} });
    const claim = requestLedger.begin({ bytes, authority: { principal: "principal-red", run_id: "run-1", world_id: "pitch", world_instance_id: "instance-1" } });
    if (claim.kind !== "new") throw new Error("request fixture claim failed");
    claim.reservation.prepare({ at_tick: sequence === 3 ? 1 : 0, queued_action: action(sequence), receipt: receipt(sequence) }); claim.reservation.commit();
  }
  const resultLedger = createWorldActionResultLedger({ maxEntriesPerPrincipal: 1, maxPrincipals: 1 }); const writer = readWorldActionResultLedger(resultLedger)!;
  writer.reserve({ bindings: [{ principal: "principal-red", actor: holder, run_id: "run-1", world_id: "pitch", world_instance_id: "instance-1", manifest_digest: manifest.digest }] });
  writer.append({ principal: "principal-red", result: { version: "simfile.world-action-result.v1", result_id: "world-result-1", receipt_id: "world-act-1", decision_id: "decision-000000000001", actor: holder, action_sequence: 1, apply_tick: 0, status: "applied", caused_effect_ids: [], identity: identity(1) } });
  writer.append({ principal: "principal-red", result: { version: "simfile.world-action-result.v1", result_id: "world-result-2", receipt_id: "world-act-2", decision_id: "decision-000000000002", actor: holder, action_sequence: 2, apply_tick: 0, status: "rejected_at_mechanics", rejection_code: "world_action_rejected", identity: identity(1) } });
  const pendingRecord = action(3);
  const pendingAttempt = { act_id: pendingRecord.receipt_id, action: pendingRecord.mechanics_action,
    actor: pendingRecord.mechanics_actor, at_tick: pendingRecord.at_tick, input: pendingRecord.lowered_input,
    origin: "agentic" as const, principal_id: pendingRecord.principal, target: pendingRecord.mechanics_target };
  return {
    version: WORLD_CHECKPOINT_VERSION,
    static: { executed_artifact_sha256: artifact, dynamics_build_receipt_sha256: "d".repeat(64), capability_manifests: [manifest] },
    dynamics: { ...dynamics(), next_tick: 1, next_action_sequence: 4,
      accepted_action_sequences: { floor: 2, above_floor: [] }, action_ingress_floor: 3,
      action_ingress_ordinal: 3, action_ingress: [{ act_id: pendingAttempt.act_id,
        at_tick: pendingAttempt.at_tick, attempt_sha256: digestDynamicsActionAttempt(pendingAttempt),
        principal_id: pendingAttempt.principal_id, retained_at_tick: pendingAttempt.at_tick,
        receipt: { act_id: pendingAttempt.act_id,
          apply_tick: pendingAttempt.at_tick, queued: true, sequence: 3 } }],
      pending_actions: [{ ...pendingAttempt, sequence: 3 }],
      resolved_action_sequences: { floor: 3, above_floor: [] } },
    decisions: { version: "simfile.decision-registry.v1", runId: "run-1", worldInstanceId: "instance-1", tokenDigestKeyFingerprint: fingerprint, phase: "open", cutoffTick: null, admissionsClosedTick: null, finalizedTick: null, lastTick: 0, nextDecisionSequence: 4, decisions: [1, 2, 3].map((sequence) => ({ decisionId: `decision-${String(sequence).padStart(12, "0")}`, principal: "principal-red", status: "consumed", issuedTick: 0, validThroughTick: 10, tokenDigest: `sha256:${String(sequence).repeat(64).slice(0, 64)}` })) },
    action_journal: journal.snapshot(), request_ledger: requestLedger.snapshot(), action_result_ledger: (resultLedger && (resultLedger as object) ? (awaitedResult(resultLedger)) : undefined),
    read_ledger: { version: "simfile.world-read-ledger.v1", max_entries_per_principal: 1, max_principals: 1, lanes: [{ principal: "principal-red", last_sequence: 1, evicted_through: 0, records: [{ sequence: 1, operation: "status", principal: "principal-red", result: "denied" }] }] },
  };
};
const awaitedResult = (ledger: ReturnType<typeof createWorldActionResultLedger>): unknown => readWorldActionResultLedger(ledger)!.exportState();

test("parses the minimal detached immutable checkpoint", () => {
  const source = empty();
  const checkpoint = accepted(source);
  assert.equal(checkpoint.version, WORLD_CHECKPOINT_VERSION);
  assert(Object.isFrozen(checkpoint));
  assert(Object.isFrozen(checkpoint.static));
  assert(Object.isFrozen(checkpoint.dynamics));
  assert(Object.isFrozen(checkpoint.dynamics.provider_state));
  assert(Object.isFrozen(checkpoint.dynamics.provenance));
  assert(Object.isFrozen(checkpoint.action_result_ledger));
  source.static = { ...(source.static as object), executed_artifact_sha256: "0".repeat(64) };
  (source.dynamics as Record<string, unknown>).provider_state = { changed: true };
  assert.equal(checkpoint.static.executed_artifact_sha256, artifact);
  assert.deepEqual(checkpoint.dynamics.provider_state, {});
});

test("accepts a compiler-built mixed pending terminal and evicted-result composition", () => {
  const source = composed();
  const checkpoint = accepted(source);
  assert.equal(checkpoint.action_journal.cells.length, 3);
  assert.equal(checkpoint.action_result_ledger.admitted, 2);
  assert.deepEqual(checkpoint.action_result_ledger.entries[0]!.values[0]!.result.status, "rejected_at_mechanics");
  assert.deepEqual(checkpoint.action_result_ledger.evicted[0], ["principal-red", 1]);
  const tampered = structuredClone(source) as Record<string, any>;
  tampered.request_ledger.records.pop();
  assert.equal(parseWorldCheckpoint(tampered), undefined);
});

test("clone is deterministic and rejects one relation tamper", () => {
  const source = accepted(empty());
  assert.deepEqual(cloneWorldCheckpoint(source), source);
  const tampered = structuredClone(source) as Record<string, any>;
  tampered.static.executed_artifact_sha256 = "0".repeat(64);
  assert.equal(parseWorldCheckpoint(tampered), undefined);
});

test("fails closed for hostile root shapes without invoking traps", () => {
  const base = empty();
  const accessor = { ...base, get dynamics() { throw new Error("trap"); } };
  assert.equal(parseWorldCheckpoint(accessor), undefined);
  const proxy = new Proxy(base, { get() { throw new Error("trap"); } });
  assert.equal(parseWorldCheckpoint(proxy), undefined);
  const sparse = empty();
  (sparse.action_journal as Record<string, unknown>).cells = new Array(1);
  assert.equal(parseWorldCheckpoint(sparse), undefined);
  const symbols = empty();
  Object.defineProperty(symbols, Symbol("extra"), { enumerable: true, value: 1 });
  assert.equal(parseWorldCheckpoint(symbols), undefined);
});

test("rejects aliases, cycles, thenables, and over-limit outer histories", () => {
  const aliased = empty();
  const shared = {};
  (aliased.dynamics as Record<string, unknown>).provider_state = shared;
  (aliased.request_ledger as Record<string, unknown>).records = [shared];
  assert.equal(parseWorldCheckpoint(aliased), undefined);
  const cycle = empty();
  (cycle.dynamics as Record<string, unknown>).provider_state = cycle.dynamics;
  assert.equal(parseWorldCheckpoint(cycle), undefined);
  const thenable = empty();
  (thenable.dynamics as Record<string, unknown>).provider_state = { then: 1 };
  assert.equal(parseWorldCheckpoint(thenable), undefined);
  const over = empty();
  (over.action_journal as Record<string, unknown>).cells = new Array(10001).fill(undefined);
  assert.equal(parseWorldCheckpoint(over), undefined);
});

test("accepts a compiler/parser manifest artifact before every identity tamper", () => {
  const artifacts = manifestArtifacts();
  assert.equal(artifacts.length, 1);
  const source = empty(); (source.static as Record<string, unknown>).capability_manifests = artifacts;
  (source.decisions as Record<string, unknown>).runId = "run-1";
  (source.decisions as Record<string, unknown>).worldInstanceId = "instance-1";
  assert(accepted(source));
  for (const field of ["run_id", "world", "holder", "surface", "manifest_digest"] as const) {
    const tampered = structuredClone(source) as Record<string, any>;
    const manifest = tampered.static.capability_manifests[0].manifest;
    if (field === "run_id") manifest.run_id = "other";
    if (field === "world") manifest.world.id = "other";
    if (field === "holder") manifest.holder.principal = "other";
    if (field === "surface") manifest.surface.registry_digest = "0".repeat(64);
    if (field === "manifest_digest") manifest.manifest_digest = "sha256:" + "0".repeat(64);
    assert.equal(parseWorldCheckpoint(tampered), undefined, field);
  }
});

test("rejects a graph that is one level deeper than the advertised cap", () => {
  const source = empty(); let value: Record<string, unknown> = {};
  for (let index = 0; index < 26; index += 1) value = { child: value };
  (source.dynamics as Record<string, unknown>).provider_state = value;
  assert.equal(parseWorldCheckpoint(source), undefined);
});

test("composes distinct allowed and denied read lanes without cross-lane equality", () => {
  const artifacts = twoManifestArtifacts(); assert.equal(artifacts.length, 2);
  const red = artifacts.find((artifact) => artifact.manifest.holder.principal === "principal-red")!;
  const source = empty();
  (source.static as Record<string, unknown>).capability_manifests = artifacts;
  (source.decisions as Record<string, unknown>).runId = "run-1";
  (source.decisions as Record<string, unknown>).worldInstanceId = "instance-1";
  (source.decisions as Record<string, unknown>).nextDecisionSequence = 3;
  (source.decisions as Record<string, unknown>).lastTick = 0;
  (source.decisions as Record<string, unknown>).decisions = [
    { decisionId: "decision-000000000001", principal: "principal-red", status: "active", issuedTick: 0, validThroughTick: 10, tokenDigest: `sha256:${"1".repeat(64)}` },
    { decisionId: "decision-000000000002", principal: "principal-blue", status: "active", issuedTick: 0, validThroughTick: 10, tokenDigest: `sha256:${"2".repeat(64)}` },
  ];
  (source.read_ledger as Record<string, unknown>).max_entries_per_principal = 2;
  (source.read_ledger as Record<string, unknown>).max_principals = 2;
  (source.read_ledger as Record<string, unknown>).lanes = [
    { principal: "principal-red", last_sequence: 1, evicted_through: 0, records: [{ sequence: 1, operation: "status", principal: "principal-red", decision_id: "decision-000000000001", state_version: 0, result: "allowed", identity: { run_id: "run-1", world_id: "pitch", world_instance_id: "instance-1", manifest_digest: red.digest, state_version: 0 } }] },
    { principal: "principal-blue", last_sequence: 1, evicted_through: 0, records: [{ sequence: 1, operation: "status", principal: "principal-blue", result: "denied" }] },
  ];
  assert(accepted(source));
  const tampered = structuredClone(source) as Record<string, any>;
  tampered.read_ledger.lanes[0].records[0].identity.manifest_digest = artifacts.find((artifact) => artifact !== red)!.digest;
  assert.equal(parseWorldCheckpoint(tampered), undefined);
});

test("requires one canonical manifest identity and parser order", () => {
  const ordered = twoManifestArtifacts();
  const source = empty(); (source.static as Record<string, unknown>).capability_manifests = [...ordered].reverse();
  (source.decisions as Record<string, unknown>).runId = "run-1";
  (source.decisions as Record<string, unknown>).worldInstanceId = "instance-1";
  assert(accepted(source));
  assert.deepEqual(accepted(source).static.capability_manifests.map((item) => item.manifest.holder.principal), ["principal-blue", "principal-red"]);
  const differentRun = twoManifestArtifacts("run-2").find((item) => item.manifest.holder.principal === "principal-blue")!;
  const mismatch = empty(); (mismatch.static as Record<string, unknown>).capability_manifests = [ordered[0], differentRun];
  assert.equal(parseWorldCheckpoint(mismatch), undefined);
});

test("rejects a one-over history before inspecting numeric index zero", () => {
  const source = empty(); const cells = new Array(10_001); let inspected = 0;
  Object.defineProperty(cells, "0", { enumerable: true, get: () => { inspected += 1; throw new Error("index zero inspected"); } });
  (source.action_journal as Record<string, unknown>).cells = cells;
  assert.equal(parseWorldCheckpoint(source), undefined);
  assert.equal(inspected, 0);
});

test("proves the C2 relation admission matrix from an accepted baseline", () => {
  type Mutable = Record<string, any>;
  type OwnerCheck = (value: Mutable, name: string) => void;
  const journalAccepted: OwnerCheck = (value, name) => assert.ok(parseWorldActionJournalSnapshot(value.action_journal), `${name}: journal owner accepted`);
  const requestAccepted: OwnerCheck = (value, name) => assert.ok(parseWorldRequestLedgerSnapshot(value.request_ledger), `${name}: request owner accepted`);
  const resultAccepted: OwnerCheck = (value, name) => assert.doesNotThrow(() => parseWorldActionResultLedgerSnapshot(value.action_result_ledger), `${name}: B71 result owner accepted`);
  const cases: readonly ([string, (value: Mutable) => void] | [string, (value: Mutable) => void, OwnerCheck])[] = [
    ["free lane principal", (v) => { v.action_journal.lanes[0].principal = "principal-blue"; }],
    ["free audit principal", (v) => { v.action_journal.audits[0].principal = "principal-blue"; }],
    ["holder grant", (v) => { v.action_journal.cells[0].record.holder = "world://pitch/entity/other"; }],
    ["affordance grant", (v) => { v.action_journal.cells[0].record.affordance = "world://pitch/affordance/other"; }],
    ["target grant", (v) => { v.action_journal.cells[0].record.target = "world://pitch/entity/other"; }],
    ["decision status", (v) => { v.decisions.decisions[0].status = "active"; }],
    ["decision run closure", (v) => { v.decisions.runId = "other-run"; }],
    ["decision instance closure", (v) => { v.decisions.worldInstanceId = "other-instance"; }],
    ["decision issued clock", (v) => { v.decisions.decisions[0].issuedTick = 2; }],
    ["decision last clock", (v) => { v.decisions.lastTick = 2; }],
    ["decision cutoff clock", (v) => { v.decisions.phase = "cutoff"; v.decisions.cutoffTick = 2; }],
    ["journal receipt", (v) => {
      const cell = v.action_journal.cells[0]; cell.receipt.apply_tick = 1; cell.record.at_tick = 1;
      cell.receipt.identity.state_version = 1; cell.record.identity.state_version = 1;
      if (cell.terminal !== null) cell.terminal.apply_tick = 1;
    }, journalAccepted],
    ["journal decision", (v) => { v.action_journal.cells[0].record.decision_id = "decision-000000000003"; }],
    ["journal state version", (v) => {
      v.action_journal.cells[0].receipt.identity.state_version = 1;
      v.action_journal.cells[0].record.identity.state_version = 1;
    }, journalAccepted],
    ["dynamics lowered input", (v) => { v.dynamics.action_ingress[0].attempt_sha256 = "0".repeat(64); }],
    ["dynamics pending join", (v) => { v.dynamics.pending_actions[0].sequence = 1; }],
    ["request authority join", (v) => {
      const record = v.request_ledger.records[0]; const oldUnits = worldRequestLedgerRecordCodeUnits(record);
      record.authority.world_id = "other-world";
      record.receipt.identity.world_id = "other-world"; record.queued_action.identity.world_id = "other-world";
      v.request_ledger.code_units += worldRequestLedgerRecordCodeUnits(record) - oldUnits;
    }, requestAccepted],
    ["request orphan", (v) => { v.request_ledger.records.pop(); }],
    ["pending receipt evidence", (v) => { v.action_result_ledger.receipt_ids[0] = "world-act-3"; }],
    ["pending decision evidence", (v) => { v.action_result_ledger.decision_ids[0] = "decision-000000000003"; }],
    ["pending sequence evidence", (v) => { v.action_result_ledger.action_sequences[0] = 3; }],
    ["retained actor", (v) => {
      const actor = "world://pitch/entity/other";
      v.action_result_ledger.bindings[0].actor = actor; v.action_result_ledger.entries[0].values[0].result.actor = actor;
    }, resultAccepted],
    ["retained rejection code", (v) => { v.action_result_ledger.entries[0].values[0].result.rejection_code = "other_code"; }],
    ["retained post state", (v) => { v.action_result_ledger.entries[0].values[0].result.identity.state_version = 0; }],
    ["unsafe successor", (v) => { v.action_journal.cells[0].terminal.apply_tick = Number.MAX_SAFE_INTEGER; }],
  ];
  for (const [name, alter, ownerCheck] of cases) {
    const source = composed(); assert(accepted(source), `${name}: baseline`);
    const tampered = structuredClone(source) as Mutable; alter(tampered);
    ownerCheck?.(tampered, name);
    assert.equal(parseWorldCheckpoint(tampered), undefined, name);
  }
});

test("rejects every bounded owner one-over before index zero", () => {
  type Mutable = Record<string, any>;
  const cases: readonly [(value: Mutable) => any, (value: Mutable, array: any[]) => void][] = [
    [(v) => v.action_journal, (v, a) => { v.cells = a; }],
    [(v) => v.dynamics, (v, a) => { v.accepted_action_sequences.above_floor = a; }],
    [(v) => v.request_ledger, (v, a) => { v.records = a; }],
    [(v) => v.read_ledger, (v, a) => { v.lanes = a; }],
  ];
  for (const [section, install] of cases) {
    const source = empty() as any, target = section(source), limit = install === cases[3]![1] ? 2 : 10_001, over = new Array(limit);
    let inspected = 0; Object.defineProperty(over, "0", { enumerable: true, get: () => { inspected += 1; throw new Error("index zero inspected"); } }); install(target, over);
    assert.equal(parseWorldCheckpoint(source), undefined); assert.equal(inspected, 0);
  }
});

test("accepts zero-effect results and independently checks global evidence sets", () => {
  const source = composed(); assert(accepted(source));
  const cases: readonly [(value: any) => void, string][] = [
    [(v) => { v.action_result_ledger.receipt_ids[1] = "world-act-3"; }, "receipt set"],
    [(v) => { v.action_result_ledger.decision_ids[1] = "decision-000000000003"; }, "decision set"],
    [(v) => { v.action_result_ledger.action_sequences[1] = 3; }, "sequence set"],
  ];
  for (const [alter, name] of cases) { const tampered = structuredClone(source) as any; alter(tampered); assert.equal(parseWorldCheckpoint(tampered), undefined, name); }
});

test("accepts legal 10,000-entry dynamics and read relation maxima", () => {
  const [manifest] = manifestArtifacts(); const source = empty() as any;
  source.static.capability_manifests = [manifest]; source.decisions.runId = "run-1"; source.decisions.worldInstanceId = "instance-1";
  source.decisions.nextDecisionSequence = 10_001; source.decisions.lastTick = 0;
  source.decisions.decisions = Array.from({ length: 10_000 }, (_, index) => ({
    decisionId: `decision-${String(index + 1).padStart(12, "0")}`, principal: "principal-red", status: "consumed", issuedTick: 0, validThroughTick: 0,
    tokenDigest: `sha256:${index.toString(16).padStart(64, "0")}`,
  }));
  source.read_ledger.max_entries_per_principal = 10_000; source.read_ledger.lanes = [{ principal: "principal-red", last_sequence: 10_000, evicted_through: 0,
    records: Array.from({ length: 10_000 }, (_, index) => ({ sequence: index + 1, operation: "status", principal: "principal-red", decision_id: "decision-000000000001",
      state_version: 0, result: "allowed", identity: { run_id: "run-1", world_id: "pitch", world_instance_id: "instance-1", manifest_digest: manifest.digest, state_version: 0 } })) }];
  assert(accepted(source));
});

test("rejects inherited, dangerous, exotic, and thenable graphs without mutation", () => {
  const hostile: readonly [string, () => Record<string, unknown>][] = [
    ["inherited", () => Object.assign(Object.create({ inherited: 1 }), empty())],
    ["dangerous", () => { const value = { ...empty(), dynamics: { ...(empty().dynamics as object) } }; Object.defineProperty(value.dynamics, "__proto__", { enumerable: true, value: 1 }); return value; }],
    ["exotic", () => ({ ...empty(), dynamics: Object.assign(new Date(), empty().dynamics) })],
    ["thenable", () => ({ ...empty(), dynamics: Object.assign({}, empty().dynamics, { provider_state: { then: 1 } }) })],
  ];
  for (const [name, make] of hostile) {
    const source = make(), before = structuredClone(source); assert.equal(parseWorldCheckpoint(source), undefined, name); assert.equal(JSON.stringify(source), JSON.stringify(before), name);
  }
});

test("exports checkpoint values without exposing host checkpoint authority", () => {
  assert.equal(worldBarrel.parseWorldCheckpoint, parseWorldCheckpoint);
  assert.equal(rootBarrel.parseWorldCheckpoint, parseWorldCheckpoint);
  assert.equal(Object.hasOwn(worldBarrel, "registerWorldRuntimeCheckpointCoordinator"), false);
  assert.equal(Object.hasOwn(rootBarrel, "restoreWorldRuntimeCheckpoint"), false);
});
