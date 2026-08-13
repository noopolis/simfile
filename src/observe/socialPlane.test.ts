import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CausalEvent } from "@noopolis/stele";
import { computeSocialPlane, type SocialTranscriptMessage } from "./socialPlane.js";

const event = (overrides: Partial<CausalEvent>): CausalEvent => ({
  version: "noopolis.causal-event.v1", run_id: "run", event_id: "moltnet:m1",
  emitter: { system: "moltnet", stream_id: "network:n", seq: 1 }, type: "message.accepted",
  principal_id: "operator:token:red-agent", recorded_at: "2026-01-01T00:00:00Z", cause_event_ids: [],
  payload: { message_id: "m1", content_sha256: "bad", policy_decision: "accepted" }, ...overrides
});

const message = (overrides: Partial<SocialTranscriptMessage> = {}): SocialTranscriptMessage => ({
  id: "m1", rendered_attribution: "red", parts: [{ kind: "text", text: "hello" }], ...overrides
});

describe("computeSocialPlane", () => {
  it("keeps anonymous attribution unattested, never passed", () => {
    const result = computeSocialPlane([message({ rendered_attribution: "red" })], [event({ principal_id: "system:moltnet.anonymous" })]);
    assert.equal(result.attribution.unattested, 1);
    assert.equal(result.verdict.status, "incomplete");
  });

  it("turns world-state data into a Clause A violation", () => {
    const result = computeSocialPlane([message({ parts: [{ kind: "text", text: "hello", data: { tick: 42 } }] })], [event({ principal_id: "system:moltnet.anonymous" })]);
    assert.deepEqual(result.world_state.violations, [{ message_id: "m1", keys: ["tick"] }]);
    assert.equal(result.verdict.status, "failed");
  });

  it("turns a causal social-to-action relation into a Clause B violation", () => {
    const accepted = event({});
    const action = event({ event_id: "world:a1", type: "world.action", cause_event_ids: [accepted.event_id], emitter: { system: "simfile", stream_id: "world", seq: 2 }, payload: { action: "move", target: "room:x" } });
    const result = computeSocialPlane([message()], [accepted, action]);
    assert.equal(result.actions.violations[0]?.action_event_id, "world:a1");
    assert.equal(result.verdict.status, "failed");
  });

  it("marks a real principal disagreement as violated", () => {
    const result = computeSocialPlane([message({ rendered_attribution: "operator" })], [event({})]);
    assert.equal(result.attribution.violated, 1);
    assert.equal(result.messages.entries[0]?.attribution, "violated");
  });
});
