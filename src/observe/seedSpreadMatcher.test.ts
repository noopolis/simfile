import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CausalEvent } from "@noopolis/stele";

import type { SeedDeclaration } from "./manifest.js";
import { computeSeedSpread, diffSeedSpreadAgainstLiveMarkerSeen, type SeedSpreadComputeInput } from "./seedSpread.js";
import { UnsupportedSpreadMatcherPolicyError } from "./spreadMatcher.js";

const seedDeclaration = (matcherPolicy: string): SeedDeclaration => ({
  content_hash: "deadbeef",
  token_set: ["Rosa Delgado"],
  matcher_policy: matcherPolicy,
  seed_agent: "eleanor",
  seed_epoch: "2026-07-12T00:00:00.000Z",
  entry_channel: "doc-seeded"
});

const inputFor = (matcherPolicy: string): SeedSpreadComputeInput => ({
  seedDeclaration: seedDeclaration(matcherPolicy),
  causalEventsById: new Map(),
  transcriptMessages: [{ id: "msg-typo", fromId: "sam", text: "The Rosa Delgato account is ready." }],
  causalEventsByBank: new Map([
    [
      "office-recall",
      [
        {
          version: "noopolis.causal-event.v1",
          event_id: "memory-recalled-typo",
          run_id: "run-seed-spread-matcher",
          recorded_at: "2026-07-12T00:00:00.000Z",
          emitter: { system: "mneme", stream_id: "memory:sam", seq: 1 },
          principal_id: "agent:sam",
          type: "memory.recalled",
          cause_event_ids: [],
          payload: { memory_id: "memory-typo" }
        } satisfies CausalEvent
      ]
    ]
  ]),
  mnemeEventsByBank: new Map([
    [
      "office-recall",
      [{ id: "memory-typo", type: "memory.observed", agentId: "sam", text: "The Rosa Delgato account is ready." }]
    ]
  ]),
  tickByMoltnetMessageId: new Map()
});

describe("computeSeedSpread — manifest matcher policy", () => {
  it("uses edit-distance fidelity for every matched spread channel", () => {
    const result = computeSeedSpread(inputFor("edit-distance:1"));
    const matchedEntries = result.entries.filter((entry) => entry.channel !== "doc-seeded");

    assert.deepEqual(
      matchedEntries.map((entry) => entry.channel),
      ["uttered", "registered", "recalled"]
    );
    for (const entry of matchedEntries) assert.equal(entry.fidelity, 1 - 1 / 12);
    assert.equal(result.entries.find((entry) => entry.channel === "doc-seeded")!.fidelity, 1);
  });

  it("fails loudly before scanning when a pinned model-backed policy is unsupported", () => {
    for (const policy of ["embedding", "judge"]) {
      const input = inputFor(policy);
      input.transcriptMessages = [];
      input.mnemeEventsByBank = new Map();
      assert.throws(() => computeSeedSpread(input), UnsupportedSpreadMatcherPolicyError);
    }
  });

  it("applies the policy to the diagnostic's independently derived uttered set", () => {
    const diff = diffSeedSpreadAgainstLiveMarkerSeen(
      [],
      [{ id: "msg-typo", fromId: "sam", text: "The Rosa Delgato account is ready." }],
      ["Rosa Delgado"],
      "edit-distance:1"
    );

    assert.deepEqual(diff.derivedHitMessageIds, ["msg-typo"]);
    assert.deepEqual(diff.onlyDerived, ["msg-typo"]);
  });
});
