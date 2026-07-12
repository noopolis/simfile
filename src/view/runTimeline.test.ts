import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { buildRunTimeline } from "./runTimeline.js";
import type { RunTimeline, RunTimelineElementKind } from "./runTimelineTypes.js";

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

const writeMultiRoomRun = async (): Promise<string> => {
  const runDir = await mkdtemp(path.join(tmpdir(), "simfile-timeline-multi-room-"));
  const moltnetDir = path.join(runDir, "raw", "moltnet");
  const daimonDir = path.join(runDir, "raw", "daimon", "alice");
  await Promise.all([mkdir(moltnetDir, { recursive: true }), mkdir(daimonDir, { recursive: true })]);

  await writeFile(path.join(runDir, "manifest.json"), JSON.stringify({
    version: "simfile.run-manifest.v1",
    run_id: "run-multi-room",
    created_at: "2026-07-12T00:00:00.000Z",
    contract_versions: {},
    artifacts: [],
    world: { network_id: "lab", room_id: "outer", members: ["alice"] },
  }), "utf8");

  const messages = [
    { id: "msg-north", room: "north", text: "north message", at: "2026-07-12T00:00:00.000Z" },
    { id: "msg-south", room: "south", text: "south message", at: "2026-07-12T00:00:01.000Z" },
  ];
  await writeFile(path.join(moltnetDir, "transcript.json"), JSON.stringify({
    transcript: messages.map((message) => ({
      id: message.id,
      network_id: "lab",
      target: { kind: "room", room_id: message.room },
      from: { type: "human", id: "operator", name: "Operator" },
      parts: [{ kind: "text", text: message.text }],
      created_at: message.at,
    })),
  }), "utf8");

  const moltnetEvents = messages.map((message, index) => ({
    version: "noopolis.causal-event.v1",
    run_id: "run-multi-room",
    event_id: `moltnet:${message.id}`,
    emitter: { system: "moltnet", stream_id: "network:lab", seq: index + 1 },
    type: "message.accepted",
    principal_id: "system:moltnet.anonymous",
    recorded_at: message.at,
    cause_event_ids: index === 0 ? [] : ["moltnet:msg-north"],
    payload: { message_id: message.id, target: { kind: "room", room_id: message.room } },
  }));
  await writeFile(
    path.join(moltnetDir, "causal.jsonl"),
    `${moltnetEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );

  const daimonEvents = [
    {
      event_id: "daimon:south:turn.input.submitted",
      seq: 1,
      type: "turn.input.submitted",
      recorded_at: "2026-07-12T00:00:01.100Z",
      cause_event_ids: ["moltnet:msg-south"],
      payload: { turn_id: "moltnet:msg-south" },
    },
    {
      event_id: "daimon:south:turn.output.completed",
      seq: 2,
      type: "turn.output.completed",
      recorded_at: "2026-07-12T00:00:01.200Z",
      cause_event_ids: ["daimon:south:turn.input.submitted"],
      payload: { turn_id: "moltnet:msg-south" },
    },
    {
      event_id: "daimon:south:wake",
      seq: 3,
      type: "control.wake.accepted",
      recorded_at: "2026-07-12T00:00:01.300Z",
      cause_event_ids: ["moltnet:msg-south"],
      payload: {},
    },
    {
      event_id: "daimon:unresolved:wake",
      seq: 4,
      type: "control.wake.accepted",
      recorded_at: "2026-07-12T00:00:01.400Z",
      cause_event_ids: ["moltnet:missing"],
      payload: {},
    },
  ].map(({ seq, ...event }) => ({
    version: "noopolis.causal-event.v1",
    run_id: "run-multi-room",
    emitter: { system: "daimon", stream_id: "agent:alice", seq },
    principal_id: "agent:alice",
    ...event,
  }));
  await writeFile(
    path.join(daimonDir, "causal.jsonl"),
    `${daimonEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );

  return runDir;
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

  it("keeps every daimon event attributed to the single room that caused it", async () => {
    const timeline = await buildRunTimeline(GOLDEN_DIR);
    const daimonEvents = timeline.events.filter((event) => event.authority === "daimon");
    assert.ok(daimonEvents.length > 0);
    for (const event of daimonEvents) {
      assert.deepEqual(event.subjects, [`agent:${event.actor}`, "room:office_lab:office-room"]);
    }
  });

  it("supports the team element kind and emits an empty membranes foundation", async () => {
    const teamKind: RunTimelineElementKind = "team";
    const timeline = await buildRunTimeline(GOLDEN_DIR);
    assert.equal(teamKind, "team");
    assert.deepEqual(timeline.membranes, []);
  });
});

describe("buildRunTimeline — multi-room daimon attribution", () => {
  it("uses the causing message room and omits a room when the cause cannot be resolved", async () => {
    const runDir = await writeMultiRoomRun();
    try {
      const timeline = await buildRunTimeline(runDir);
      for (const eventId of [
        "daimon:south:turn.input.submitted",
        "daimon:south:turn.output.completed",
        "daimon:south:wake",
      ]) {
        assert.deepEqual(eventById(timeline, eventId).subjects, ["agent:alice", "room:lab:south"]);
      }
      assert.deepEqual(eventById(timeline, "daimon:unresolved:wake").subjects, ["agent:alice"]);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
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
