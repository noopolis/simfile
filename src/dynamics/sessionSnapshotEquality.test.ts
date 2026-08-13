import assert from "node:assert/strict";
import test from "node:test";

import { canonicalDynamicsJson } from "./canonicalJson.js";
import { dynamicsActionIdempotencyRecordCodeUnits } from "./actionRetention.js";
import { DYNAMICS_ACTION_RETENTION_LIMITS, DYNAMICS_LIMITS } from "./limits.js";
import { sameDynamicsSessionSnapshot } from "./sameDynamicsSessionSnapshot.js";
import { parseDynamicsSessionSnapshot } from "./snapshotValidation.js";
import type { DynamicsSessionSnapshot } from "./types.js";

const snapshotWithIngress = (changed = false): DynamicsSessionSnapshot => ({
  accepted_action_sequences: { floor: 1, above_floor: [] },
  action_ingress: Array.from({ length: DYNAMICS_ACTION_RETENTION_LIMITS.records }, (_, index) => {
    const suffix = index.toString().padStart(4, "0");
    const actId = `${"\0".repeat(DYNAMICS_LIMITS.identifier_code_units - suffix.length)}${suffix}`;
    return {
      act_id: actId,
      at_tick: 1,
      attempt_sha256: index.toString(16).padStart(64, "0"),
      principal_id: "\0".repeat(DYNAMICS_LIMITS.identifier_code_units),
      retained_at_tick: 0,
      receipt: { act_id: actId, apply_tick: 0, code: "wrong_tick", queued: false },
    };
  }),
  action_ingress_floor: 1,
  action_ingress_ordinal: DYNAMICS_ACTION_RETENTION_LIMITS.records,
  next_action_sequence: 1,
  next_event_sequence: 1,
  next_tick: 0,
  pending_actions: [],
  provider_state: { value: changed ? 1 : 0 },
  provenance: {
    api_version: "simfile.dynamics-provider.v1",
    config_sha256: "0".repeat(64),
    module: "test",
    module_sha256: "1".repeat(64),
    node_version: "test",
    numeric_model: "ieee754-binary64",
    provider_dependencies: {},
    provider_id: "test",
    provider_version: "1",
    state_schema_version: "v1",
  },
  resolved_action_sequences: { floor: 1, above_floor: [] },
  seed: "seed",
  sim_seconds_per_tick: 1,
  version: "simfile.dynamics-snapshot.v1",
});

test("compares large valid session snapshots without the generic JSON ceiling", () => {
  const equal = snapshotWithIngress();
  const different = snapshotWithIngress(true);
  assert.deepEqual(parseDynamicsSessionSnapshot(equal), equal);
  const idCodeUnitsLowerBound = equal.action_ingress.reduce(
    (total, record) => total + record.act_id.length + record.receipt.act_id.length,
    0,
  );
  assert.ok(idCodeUnitsLowerBound >= DYNAMICS_LIMITS.json_code_units);
  assert.ok(equal.action_ingress.reduce((total, record) => total + dynamicsActionIdempotencyRecordCodeUnits(record), 0) > DYNAMICS_LIMITS.json_code_units);
  assert.throws(() => canonicalDynamicsJson(equal), /json_code_units|json nodes|JSON/u);
  assert.equal(sameDynamicsSessionSnapshot(equal, snapshotWithIngress()), true);
  assert.equal(sameDynamicsSessionSnapshot(equal, different), false);
  const providerStateMutation = snapshotWithIngress();
  providerStateMutation.provider_state = { value: 2 };
  assert.equal(sameDynamicsSessionSnapshot(equal, providerStateMutation), false);
  const retainedIngressMutation = snapshotWithIngress();
  retainedIngressMutation.action_ingress[0]!.attempt_sha256 = "f".repeat(64);
  assert.equal(sameDynamicsSessionSnapshot(equal, retainedIngressMutation), false);
});
