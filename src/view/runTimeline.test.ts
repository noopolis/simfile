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
const WORLD_GOLDEN_DIR = path.resolve(here, "..", "..", "fixtures", "observe", "office-secret-v0-golden");
const VARIABLE_GOLDEN_DIR = path.resolve(here, "..", "..", "fixtures", "observe", "office-pressure-v0-golden");
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

describe("buildRunTimeline — world stream (buildWorldRecord, increment 3)", () => {
  it("gives clock.sync the clock viewClass, anchored on the clock:global subject, never a room", async () => {
    const timeline = await buildRunTimeline(WORLD_GOLDEN_DIR);
    const clockEvents = timeline.events.filter((event) => event.type === "clock.sync");
    assert.equal(clockEvents.length, 2);
    for (const event of clockEvents) {
      assert.equal(event.viewClass, "clock");
      assert.deepEqual(event.subjects, ["clock:global"]);
      assert.equal(event.authority, "world");
    }
    // Real tick/phase data, joined verbatim from the event's own payload — never invented.
    assert.deepEqual(
      clockEvents.map((event) => (event.payload as { tick: number }).tick),
      [0, 1],
    );
  });

  it("gives marker.seen the marker viewClass, attributed to the room plus the real agent who authored the tripping message", async () => {
    const timeline = await buildRunTimeline(WORLD_GOLDEN_DIR);
    const markerEvents = timeline.events.filter((event) => event.type === "marker.seen");
    assert.equal(markerEvents.length, 2);

    const eleanorMarker = markerEvents.find((event) =>
      (event.payload as { source_event_id: string }).source_event_id === "msg_7623bed7-0c13-4b28-8682-9a2dd990ee6d");
    assert.ok(eleanorMarker);
    assert.equal(eleanorMarker!.viewClass, "marker");
    assert.equal(eleanorMarker!.actor, "eleanor");
    assert.deepEqual(eleanorMarker!.subjects, ["room:office_lab:office-room", "agent:eleanor"]);

    const samMarker = markerEvents.find((event) =>
      (event.payload as { source_event_id: string }).source_event_id === "msg_89afdb35-ee62-4256-b403-84eee53cb830");
    assert.ok(samMarker);
    assert.equal(samMarker!.actor, "sam");
    assert.deepEqual(samMarker!.subjects, ["room:office_lab:office-room", "agent:sam"]);
  });

  it("gives world.message the message viewClass, attributed to the room, with text joined from its own content field", async () => {
    const timeline = await buildRunTimeline(WORLD_GOLDEN_DIR);
    const worldMessage = eventById(timeline, "simfile:run-289dccce5595430e8e8e8e0faf48b4d3:3");
    assert.equal(worldMessage.viewClass, "message");
    assert.equal(worldMessage.authority, "world");
    assert.deepEqual(worldMessage.subjects, ["room:office_lab:office-room"]);
    assert.match(worldMessage.text ?? "", /finalize the office pilot rollout/i);
  });

  it("joins the moltnet echo's worldEventId back to the real world.message event id (dedup breadcrumb)", async () => {
    const timeline = await buildRunTimeline(WORLD_GOLDEN_DIR);
    const echo = eventById(timeline, "moltnet:simfile:run-289dccce5595430e8e8e8e0faf48b4d3:3");
    assert.equal(echo.worldEventId, "simfile:run-289dccce5595430e8e8e8e0faf48b4d3:3");

    // Genuine agent-authored moltnet messages carry no such breadcrumb.
    const eleanorReply = eventById(timeline, "moltnet:msg_7623bed7-0c13-4b28-8682-9a2dd990ee6d");
    assert.equal(eleanorReply.worldEventId, undefined);
  });

  it("has no world-authority events at all for a run with no raw/world/causal.jsonl (graceful absence)", async () => {
    const timeline = await buildRunTimeline(GOLDEN_DIR);
    assert.equal(timeline.events.some((event) => event.authority === "world"), false);
    assert.equal(timeline.events.some((event) => event.viewClass === "clock" || event.viewClass === "marker"), false);
  });
});

const writeWorldWakeRun = async (): Promise<string> => {
  const runDir = await mkdtemp(path.join(tmpdir(), "simfile-timeline-world-wake-"));
  const worldDir = path.join(runDir, "raw", "world");
  const moltnetDir = path.join(runDir, "raw", "moltnet");
  await Promise.all([mkdir(worldDir, { recursive: true }), mkdir(moltnetDir, { recursive: true })]);

  await writeFile(path.join(runDir, "manifest.json"), JSON.stringify({
    version: "simfile.run-manifest.v1",
    run_id: "run-world-wake",
    created_at: "2026-07-12T00:00:00.000Z",
    contract_versions: {},
    artifacts: [],
    world: { network_id: "lab", room_id: "hall", members: ["alice"] },
  }), "utf8");

  await writeFile(path.join(moltnetDir, "transcript.json"), JSON.stringify({ transcript: [] }), "utf8");
  await writeFile(path.join(moltnetDir, "causal.jsonl"), "", "utf8");

  const worldEvents = [
    {
      event_id: "simfile:run-world-wake:1",
      seq: 1,
      type: "wake.recommended",
      recorded_at: "2026-07-12T00:00:00.000Z",
      cause_event_ids: [],
      payload: {
        sim_time: 300, provenance: "mechanical", actor: "deadline_bites",
        target: "agent:alice", scope: "agent:alice", act_id: "run-world-wake:act:1",
        action: "wake:recommend", value: null, reason: "deadline_bites", tick: 5, phase: "workday",
      },
    },
  ].map(({ seq, ...event }) => ({
    version: "noopolis.causal-event.v1",
    run_id: "run-world-wake",
    emitter: { system: "simfile", stream_id: "world", seq },
    principal_id: "system:simfile.world",
    ...event,
  }));
  await writeFile(
    path.join(worldDir, "causal.jsonl"),
    `${worldEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );

  return runDir;
};

describe("buildRunTimeline — world stream wake.recommended (synthetic fixture)", () => {
  it("gives wake.recommended the wake viewClass, attributed to the agent target ref (no fixture in this repo ships a real one)", async () => {
    const runDir = await writeWorldWakeRun();
    try {
      const timeline = await buildRunTimeline(runDir);
      const wake = eventById(timeline, "simfile:run-world-wake:1");
      assert.equal(wake.viewClass, "wake");
      assert.deepEqual(wake.subjects, ["agent:alice"]);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});

describe("buildRunTimeline — variable storyline (buildWorldRecord, increment 4)", () => {
  it("enumerates a variable element for filing_pressure, derived from its own records (not a separate schema/telemetry read)", async () => {
    const timeline = await buildRunTimeline(VARIABLE_GOLDEN_DIR);
    const variableElement = timeline.elements.find((element) => element.ref === "variable:filing_pressure");
    assert.ok(variableElement, "expected a variable:filing_pressure element");
    assert.equal(variableElement!.kind, "variable");
    assert.equal(variableElement!.label, "filing_pressure");
  });

  it("attributes the threshold rule's rule.fired and its resulting world.message to variable:filing_pressure, alongside the room", async () => {
    const timeline = await buildRunTimeline(VARIABLE_GOLDEN_DIR);
    const pressureFired = timeline.events.find(
      (event) => event.type === "rule.fired" && (event.payload as { rule?: string }).rule === "pressure_alert",
    );
    assert.ok(pressureFired, "expected pressure_alert's rule.fired event");
    assert.ok(pressureFired!.subjects.includes("variable:filing_pressure"));
    assert.ok(pressureFired!.subjects.includes("room:office_lab:office-room"));

    const pressureMessage = timeline.events.find(
      (event) => event.viewClass === "message" && event.authority === "world" && (event.text ?? "").includes("Deadline pressure is high"),
    );
    assert.ok(pressureMessage, "expected the pressure_alert world.message event");
    assert.ok(pressureMessage!.subjects.includes("variable:filing_pressure"));
  });

  it("never attributes a plain clock.sync tick (or the unrelated kickoff rule) to the variable — no fabricated subject", async () => {
    const timeline = await buildRunTimeline(VARIABLE_GOLDEN_DIR);
    const clockEvents = timeline.events.filter((event) => event.type === "clock.sync");
    assert.ok(clockEvents.length > 0);
    for (const event of clockEvents) {
      assert.equal(event.subjects.includes("variable:filing_pressure"), false);
    }

    const kickoffFired = timeline.events.find(
      (event) => event.type === "rule.fired" && (event.payload as { rule?: string }).rule === "kickoff",
    );
    assert.ok(kickoffFired, "expected kickoff's rule.fired event");
    assert.equal(kickoffFired!.subjects.includes("variable:filing_pressure"), false);
  });

  it("has no variable elements at all for a run with no world stream (office-sim-golden, graceful absence)", async () => {
    const timeline = await buildRunTimeline(GOLDEN_DIR);
    assert.equal(timeline.elements.some((element) => element.kind === "variable"), false);
  });
});

const JUNGIAN_GOLDEN_DIR = path.resolve(here, "..", "..", "fixtures", "observe", "jungian-daimon-org-golden");

describe("buildRunTimeline — jungian psyche golden (multi-network membranes)", () => {
  it("derives a membrane per interior self-team from the run's compile report", async () => {
    const timeline = await buildRunTimeline(JUNGIAN_GOLDEN_DIR);
    assert.deepEqual((timeline.membranes ?? []).map((m) => m.ref), ["team:luna", "team:selene"]);
    const luna = (timeline.membranes ?? []).find((m) => m.ref === "team:luna");
    assert.equal(luna?.representative, "agent:luna-representative");
    assert.deepEqual(luna?.interiorRooms, ["room:luna_inner:luna-council"]);
  });

  it("enumerates team elements alongside each network's room element", async () => {
    const timeline = await buildRunTimeline(JUNGIAN_GOLDEN_DIR);
    const byKind = (kind: RunTimelineElementKind) => timeline.elements.filter((e) => e.kind === kind).map((e) => e.ref).sort();
    assert.deepEqual(byKind("team"), ["team:luna", "team:selene"]);
    assert.ok(byKind("room").includes("room:luna_inner:luna-council"));
    assert.ok(byKind("room").includes("room:psyche-floor:commons"));
  });

  it("attributes an inner-council message to its own network room, not the floor (the multi-network subject fix)", async () => {
    const timeline = await buildRunTimeline(JUNGIAN_GOLDEN_DIR);
    const councilMessages = timeline.events.filter(
      (e) => e.viewClass === "message" && e.subjects.includes("room:luna_inner:luna-council"),
    );
    // The representative's inward convene + the animus + the shadow replies all live in the council room.
    assert.ok(councilMessages.length >= 3, `expected >=3 council messages, got ${councilMessages.length}`);
    // No council message ever leaks onto the floor room.
    assert.ok(!councilMessages.some((e) => e.subjects.includes("room:psyche-floor:commons")));
    // The floor carries the representative's synthesis answer, not the council chatter.
    const floorSynthesis = timeline.events.find(
      (e) => e.viewClass === "message" && e.actor === "luna-representative" && e.subjects.includes("room:psyche-floor:commons") && (e.text ?? "").includes("council has spoken"),
    );
    assert.ok(floorSynthesis, "expected the representative's synthesis on the floor");
  });
});
