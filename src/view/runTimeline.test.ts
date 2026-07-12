import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { buildRunTimeline } from "./runTimeline.js";
import type { RunTimeline } from "./runTimelineTypes.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = path.resolve(here, "..", "..", "fixtures", "observe", "office-sim-golden");
const REAL_RUN_DIR = path.resolve(
  here,
  "..",
  "..",
  "runs",
  "real-grok-composed",
  "run-b7ef07f0fd2c4779894c2bb746140972",
);

const eventById = (timeline: RunTimeline, eventId: string) => {
  const event = timeline.events.find((candidate) => candidate.eventId === eventId);
  assert.ok(event, `expected timeline to contain event ${eventId}`);
  return event!;
};

describe("buildRunTimeline — golden fixture", () => {
  it("merges every causal.jsonl + mneme events.jsonl record into a dense, deterministic t axis", async () => {
    const timeline = await buildRunTimeline(GOLDEN_DIR);
    assert.equal(timeline.version, "simfile.run-timeline.v1");
    assert.equal(timeline.runId, "run-58fa4bd3beed42e5954517389dca2646");
    // 4 moltnet + 6 daimon:eleanor + 3 daimon:sam + 5 mneme causal + 10 mneme events.jsonl
    assert.equal(timeline.events.length, 28);
    timeline.events.forEach((event, index) => assert.equal(event.t, index, "t must be dense 0..N-1"));
  });

  it("is deterministic across rebuilds (fixture-pinned merge order)", async () => {
    const first = await buildRunTimeline(GOLDEN_DIR);
    const second = await buildRunTimeline(GOLDEN_DIR);
    assert.deepEqual(
      first.events.map((event) => event.eventId),
      second.events.map((event) => event.eventId),
    );
    // The seed message is causally first and must scrub first.
    assert.equal(first.events[0]!.eventId, "moltnet:msg_99fc83b2-da39-437e-8d32-a0e3f1dd4a1b");
    assert.equal(first.events[0]!.viewClass, "message");
    assert.match(first.events[0]!.text ?? "", /finalize the office pilot rollout/i);
  });

  it("never places an event before any of its own causes (causal-repair property)", async () => {
    const timeline = await buildRunTimeline(GOLDEN_DIR);
    const tById = new Map(timeline.events.map((event) => [event.eventId, event.t] as const));
    for (const event of timeline.events) {
      for (const causeId of event.causes) {
        const causeT = tById.get(causeId);
        if (causeT === undefined) continue; // cause outside this run's recorded set
        assert.ok(causeT < event.t, `${event.eventId} (t=${event.t}) must come after its cause ${causeId} (t=${causeT})`);
      }
    }
  });

  it("joins turn 3's turn.input to the message id and its two mneme: recall causes (id-based, not ordinal)", async () => {
    const timeline = await buildRunTimeline(GOLDEN_DIR);
    const turn3Input = eventById(timeline, "daimon:moltnet:msg_13f51ee4-37f9-43f6-8399-23a95a27263c:turn.input.submitted");
    assert.equal(turn3Input.viewClass, "turn.input");
    assert.ok(turn3Input.causes.includes("moltnet:msg_13f51ee4-37f9-43f6-8399-23a95a27263c"));
    const recallCauses = turn3Input.causes.filter((causeId) => causeId.startsWith("mneme:"));
    assert.equal(recallCauses.length, 2);
  });

  it("enumerates elements from manifest world members, daimon stream slugs, and mneme banks", async () => {
    const timeline = await buildRunTimeline(GOLDEN_DIR);
    const refs = timeline.elements.map((element) => element.ref).sort();
    assert.deepEqual(refs, ["agent:eleanor", "agent:sam", "bank:office-recall", "room:office_lab:office-room"].sort());
  });
});

describe("buildRunTimeline — real grok composed run", () => {
  it("merges the real run's records and renders the real grok dialogue", async () => {
    const timeline = await buildRunTimeline(REAL_RUN_DIR);
    assert.equal(timeline.runId, "run-b7ef07f0fd2c4779894c2bb746140972");
    // 4 moltnet + 6 daimon:eleanor + 4 daimon:sam + 8 mneme causal + 10 mneme events.jsonl
    assert.equal(timeline.events.length, 32);
    timeline.events.forEach((event, index) => assert.equal(event.t, index));

    const dialogue = timeline.events.map((event) => event.text ?? "").join(" ");
    assert.match(dialogue, /Riverside Annex/);
    assert.match(dialogue, /Suite 204/);
    assert.match(dialogue, /July 28/);
  });

  it("never places an event before any of its own causes", async () => {
    const timeline = await buildRunTimeline(REAL_RUN_DIR);
    const tById = new Map(timeline.events.map((event) => [event.eventId, event.t] as const));
    for (const event of timeline.events) {
      for (const causeId of event.causes) {
        const causeT = tById.get(causeId);
        if (causeT === undefined) continue;
        assert.ok(causeT < event.t);
      }
    }
  });

  it("joins eleanor's second turn.input to its two mneme: recall causes by id", async () => {
    const timeline = await buildRunTimeline(REAL_RUN_DIR);
    const turnInput = eventById(timeline, "daimon:moltnet:msg_37bc09cc-3428-4d3c-bf90-ae5b14ad8d5d:turn.input.submitted");
    assert.ok(turnInput.causes.includes("moltnet:msg_37bc09cc-3428-4d3c-bf90-ae5b14ad8d5d"));
    const recallCauses = turnInput.causes.filter((causeId) => causeId.startsWith("mneme:"));
    assert.equal(recallCauses.length, 2);
    assert.equal(turnInput.subjects.includes("agent:eleanor"), true);
  });

  it("attaches the seed message to agent:world and the office room", async () => {
    const timeline = await buildRunTimeline(REAL_RUN_DIR);
    const seed = eventById(timeline, "moltnet:seed-1783803725750");
    assert.equal(seed.viewClass, "message");
    assert.ok(seed.subjects.includes("agent:world"));
    assert.ok(seed.subjects.includes("room:office_lab:office-room"));
  });
});
