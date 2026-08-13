/** Hard v1 resource ceilings enforced by the host before accepting provider data. */
export const DYNAMICS_LIMITS = Object.freeze({
  actions_per_tick: 128,
  causes_per_event: 128,
  events_per_tick: 256,
  identifier_code_units: 256,
  json_code_units: 65_536,
  json_depth: 24,
  json_nodes: 4_096,
  json_string_length: 16_384,
  message_code_units: 4_096,
  observation_channels: 256,
  observation_components_per_channel: 256,
  retained_action_code_units: 1_048_576,
  retained_action_records: 10_000,
  sense_grants: 128,
  spatial_objects: 256
});

const SHA256_CODE_UNITS = 64;
const JSON_ESCAPE_CODE_UNITS = "\\u0000".length;
const MAXIMUM_INTEGER_CODE_UNITS = String(Number.MAX_SAFE_INTEGER).length;
const maximumJsonStringCodeUnits = (codeUnits: number): number =>
  2 + codeUnits * JSON_ESCAPE_CODE_UNITS;
const queuedIngressShapeCodeUnits = JSON.stringify({
  act_id: "",
  at_tick: 0,
  attempt_sha256: "",
  principal_id: "",
  retained_at_tick: 0,
  receipt: { act_id: "", apply_tick: 0, queued: true, sequence: 0 }
}).length
  + maximumJsonStringCodeUnits(DYNAMICS_LIMITS.identifier_code_units) * 3 - 6
  + SHA256_CODE_UNITS
  + (MAXIMUM_INTEGER_CODE_UNITS - 1) * 4;
const rejectedIngressShapeCodeUnits = JSON.stringify({
  act_id: "",
  at_tick: 0,
  attempt_sha256: "",
  principal_id: "",
  receipt: { act_id: "", apply_tick: 0, code: "wrong_tick", queued: false }
}).length
  + maximumJsonStringCodeUnits(DYNAMICS_LIMITS.identifier_code_units) * 3 - 6
  + SHA256_CODE_UNITS
  + (MAXIMUM_INTEGER_CODE_UNITS - 1) * 2;
const RETAINED_INGRESS_RECORD_CODE_UNITS = Math.max(
  queuedIngressShapeCodeUnits,
  rejectedIngressShapeCodeUnits
);

export const DYNAMICS_ACTION_RETENTION_LIMITS = Object.freeze({
  code_units: DYNAMICS_LIMITS.actions_per_tick
    * RETAINED_INGRESS_RECORD_CODE_UNITS,
  record_code_units: RETAINED_INGRESS_RECORD_CODE_UNITS,
  records: DYNAMICS_LIMITS.actions_per_tick
});
