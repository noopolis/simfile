import assert from "node:assert/strict";
import test from "node:test";

import { createDynamicsSession } from "../dynamics/session.js";
import { readWorldActionResultLedger } from "./actionResultLedger.js";
import { readWorldRuntimeActionResultLedgerInspection } from "./actionResultLedgerInspection.js";
import { readWorldRuntimeClockAuthority } from "./clockAuthority.js";
import { parseWorldCheckpoint } from "./checkpoint.js";
import { readWorldRuntimeCheckpointCoordinator } from "./checkpointRuntime.js";
import { reserveDecisionForAct } from "./decisionRegistry.js";
import { createWorldRuntime, type WorldRuntime } from "./runtime.js";
import { runtimeFixture } from "./runtime.test-helper.js";
import * as worldBarrel from "./index.js";
import * as packageBarrel from "../index.js";

const artifactSha = "1".repeat(64);
const receiptSha = "2".repeat(64);

const issuedCheckpointFixture = () => {
  const base = runtimeFixture(false);
  const providerState: Record<string, unknown> = { value: 0 };
  let runtime: WorldRuntime | undefined;
  let coordinator: ReturnType<typeof readWorldRuntimeCheckpointCoordinator>;
  let reenterSnapshot = false;
  let clockDuringSnapshot = false;
  let captureDuringStep = false;
  let closeOnStep = false;
  let nestedRuntimeError: unknown;
  let nestedClockError: unknown;
  let nestedCaptureError: unknown;
  const dynamics = createDynamicsSession({
    api_version: "simfile.dynamics-provider.v1",
    id: "checkpoint-test",
    version: "1",
    state_schema_version: "v1",
    integration: {},
    initialize: () => {},
    observe: () => ({ channels: [] }),
    restore: (value) => {
      Object.assign(providerState, value);
      for (const key of Object.keys(providerState)) if (!Object.hasOwn(value as object, key)) delete providerState[key];
    },
    snapshot: () => {
      if (reenterSnapshot) {
        try { runtime!.status({ principal: "principal-red", decisionToken: base.red.token }); }
        catch (error) { nestedRuntimeError = error; }
      }
      if (clockDuringSnapshot) {
        try { readWorldRuntimeClockAuthority(runtime!)!.stepDynamics(); }
        catch (error) { nestedClockError = error; }
      }
      return structuredClone(providerState) as never;
    },
    step: (input) => {
      if (captureDuringStep) {
        try { coordinator!.capture(); }
        catch (error) { nestedCaptureError = error; }
      }
      const source = input as { readonly tick: number };
      return { action_results: [], events: [], tick: closeOnStep ? source.tick + 1 : source.tick };
    },
  }, {
    buildReceipt: { receiptSha256: receiptSha },
    config: {},
    seed: "seed",
    simSecondsPerTick: 1,
    provenance: {
      api_version: "simfile.dynamics-provider.v1",
      config_sha256: "0".repeat(64),
      module: "checkpoint-test",
      module_sha256: artifactSha,
      node_version: "test",
      numeric_model: "ieee754-binary64",
      provider_dependencies: {},
      provider_id: "checkpoint-test",
      provider_version: "1",
      state_schema_version: "v1",
    },
  } as never);
  runtime = createWorldRuntime({
    dynamics,
    surfaceRegistry: base.surfaceRegistry,
    capabilityManifests: base.capabilityManifests,
    boundGrants: base.boundGrants,
    decisionRegistry: base.decisionRegistry,
    readLedger: base.readLedger,
  });
  coordinator = readWorldRuntimeCheckpointCoordinator(runtime);
  assert.ok(coordinator);
  return {
    ...base,
    dynamics,
    runtime,
    coordinator,
    nestedRuntimeError: () => nestedRuntimeError,
    nestedClockError: () => nestedClockError,
    nestedCaptureError: () => nestedCaptureError,
    reenterSnapshot: (enabled: boolean) => { reenterSnapshot = enabled; nestedRuntimeError = undefined; },
    clockDuringSnapshot: (enabled: boolean) => { clockDuringSnapshot = enabled; nestedClockError = undefined; },
    captureDuringStep: (enabled: boolean) => { captureDuringStep = enabled; nestedCaptureError = undefined; },
    closeOnStep: (enabled: boolean) => { closeOnStep = enabled; },
  };
};

test("host-only coordinator captures one valid immutable whole-world checkpoint", () => {
  const fixture = issuedCheckpointFixture();
  const first = fixture.coordinator.capture();
  const second = fixture.coordinator.capture();
  assert.deepEqual(second, first);
  assert.ok(parseWorldCheckpoint(first));
  assert.equal(first.static.executed_artifact_sha256, artifactSha);
  assert.equal(first.static.dynamics_build_receipt_sha256, receiptSha);
  assert.deepEqual(first.static.capability_manifests, fixture.capabilityManifests);
  assert.notEqual(first.static.capability_manifests, fixture.capabilityManifests);
  assert.equal(first.dynamics.next_tick, fixture.dynamics.nextTick);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.static), true);
  assert.equal(Object.isFrozen(first.action_result_ledger), true);
  const bytes = Buffer.from(JSON.stringify(first));
  assert.equal(bytes.includes(Buffer.from(fixture.red.token)), false);
  assert.equal(bytes.includes(Buffer.from(fixture.blue.token)), false);
  assert.deepEqual(Reflect.ownKeys(fixture.coordinator), ["capture"]);
  assert.equal("capture" in fixture.runtime, false);
  assert.equal("readWorldRuntimeCheckpointCoordinator" in worldBarrel, false);
  assert.equal("readWorldRuntimeCheckpointCoordinator" in packageBarrel, false);
});

test("capture reentry fails without an audit or component mutation and then retries", () => {
  const fixture = issuedCheckpointFixture();
  const before = fixture.coordinator.capture();
  fixture.reenterSnapshot(true);
  assert.throws(() => fixture.coordinator.capture(), /capture unavailable/u);
  assert.ok(fixture.nestedRuntimeError());
  fixture.reenterSnapshot(false);
  assert.deepEqual(fixture.coordinator.capture(), before);
});

test("a nested clock call during capture fails without mutation and then retries", () => {
  const fixture = issuedCheckpointFixture();
  const before = fixture.coordinator.capture();
  fixture.clockDuringSnapshot(true);
  assert.throws(() => fixture.coordinator.capture(), /capture unavailable/u);
  assert.match(String(fixture.nestedClockError()), /reentry/u);
  fixture.clockDuringSnapshot(false);
  assert.deepEqual(fixture.coordinator.capture(), before);
});

test("a live owner reservation rejects capture and exact abort permits retry", () => {
  const fixture = issuedCheckpointFixture();
  const before = fixture.coordinator.capture();
  const reservation = reserveDecisionForAct(fixture.decisionRegistry, {
    principal: "principal-red",
    runId: "run-1",
    worldInstanceId: "instance-1",
    token: fixture.red.token,
    atTick: 0,
  });
  assert.throws(() => fixture.coordinator.capture());
  reservation.abort();
  assert.deepEqual(fixture.coordinator.capture(), before);
});

test("a late result reservation rejects capture and exact abort permits retry", () => {
  const fixture = issuedCheckpointFixture();
  const before = fixture.coordinator.capture();
  const resultLedger = readWorldRuntimeActionResultLedgerInspection(fixture.runtime);
  const authority = readWorldActionResultLedger(resultLedger);
  assert.ok(authority);
  const reservation = authority.reserveBatch({
    actions: [{
      principal: "principal-red",
      receipt_id: "world-act-1",
      decision_id: fixture.red.decisionId,
      action_sequence: 1,
      declared_rejection_codes: [],
    }],
    effect_capacity: 0,
  });
  assert.throws(() => fixture.coordinator.capture());
  reservation.abort();
  assert.deepEqual(fixture.coordinator.capture(), before);
});

test("capture attempted inside a clock tick does not poison the tick", () => {
  const fixture = issuedCheckpointFixture();
  fixture.captureDuringStep(true);
  assert.deepEqual(readWorldRuntimeClockAuthority(fixture.runtime)!.stepDynamics(), {
    tick: 0,
    action_results: 0,
    events: 0,
  });
  assert.match(String(fixture.nestedCaptureError()), /not stable/u);
  fixture.captureDuringStep(false);
  assert.equal(fixture.coordinator.capture().dynamics.next_tick, 1);
});

test("a closed but quiescent runtime remains capturable", () => {
  const fixture = issuedCheckpointFixture();
  fixture.closeOnStep(true);
  assert.throws(() => readWorldRuntimeClockAuthority(fixture.runtime)!.stepDynamics());
  fixture.closeOnStep(false);
  assert.throws(() => readWorldRuntimeClockAuthority(fixture.runtime)!.stepDynamics(), /closed/u);
  const closed = fixture.coordinator.capture();
  assert.equal(closed.action_journal.closed, true);
  assert.equal(closed.request_ledger.closed, true);
  assert.equal(closed.dynamics.next_tick, 0);
  assert.ok(parseWorldCheckpoint(closed));
  assert.deepEqual(fixture.coordinator.capture(), closed);
});

test("invalid static receipt fails capture without changing legacy runtime behavior", () => {
  const fixture = runtimeFixture();
  const coordinator = readWorldRuntimeCheckpointCoordinator(fixture.runtime);
  assert.ok(coordinator);
  assert.throws(() => coordinator.capture(), /capture unavailable/u);
  assert.equal(fixture.runtime.status({ principal: "principal-red", decisionToken: fixture.red.token }).identity.state_version, 0);
});
