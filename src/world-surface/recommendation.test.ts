import assert from "node:assert/strict";
import test from "node:test";

import { parseWorldSurfaceObservation } from "./observation.js";
import { WORLD_OBSERVATION_RECOMMENDATION_UNIT } from "./recommendation.js";

const valid = () => ({
  channels: [{
    components: { epoch: 4, reason_code: 2 },
    sense_address: "sense:decision-view",
    subject_address: "entity:self",
    unit: WORLD_OBSERVATION_RECOMMENDATION_UNIT,
  }],
});

test("recommendations are bounded numeric observation metadata", () => {
  assert.doesNotThrow(() => parseWorldSurfaceObservation(valid(), "recommendation"));
  for (const components of [
    { epoch: 4, reason_code: 0 },
    { epoch: -1, reason_code: 2 },
    { epoch: 4, reason_code: 2, send_nudge: 1 },
    { epoch: 4, reason_code: 2, dm: 1 },
    { epoch: 4, reason_code: 2, mention: 1 },
    { epoch: 4, reason_code: 2, recipient: 1 },
    { epoch: 4, reason_code: 2, wake_recommended: 1 },
    { epoch: 4, reason_code: 2, wake_event: 1 },
    { epoch: 4, reason_code: 2, decision_token: 1 },
    { epoch: 4, reason_code: 2, decision_id: 1 },
  ]) {
    assert.throws(() => parseWorldSurfaceObservation({
      channels: [{ ...valid().channels[0], components }],
    }, "recommendation"), /recommendation metadata/u);
  }
});

test("wake-eligible envelopes cannot masquerade as recommendation channels", () => {
  for (const field of [
    "delivery", "message", "recipient", "WakeEvent", "wake.recommended",
    "send_nudge", "dm", "mention", "decision_token", "decision_id",
  ] as const) {
    assert.throws(() => parseWorldSurfaceObservation({
      channels: [{ ...valid().channels[0], [field]: "hostile" }],
    }, "recommendation"), /unknown field/u);
  }
});
