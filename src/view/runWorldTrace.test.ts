import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { buildRunTimeline } from "./runTimeline.js";
import { buildMembraneInteriorWorlds, buildRunWorldTrace, NO_PLACE_CAPTION } from "./runWorldTrace.js";
import { readRunSpatialWorld } from "./runWorldTraceSpatial.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REAL_RUN_DIR = path.resolve(
  here,
  "..",
  "..",
  "runs",
  "real-grok-composed",
  "run-b7ef07f0fd2c4779894c2bb746140972",
);
const JUNGIAN_GOLDEN_DIR = path.resolve(here, "..", "..", "fixtures", "observe", "jungian-daimon-org-golden");
const OFFICE_PSYCHE_GOLDEN_DIR = path.resolve(here, "..", "..", "fixtures", "observe", "office-psyche-golden");

describe("buildRunWorldTrace", () => {
  it("adapts the real run's timeline into a single informational room anchor with heuristic agents", async () => {
    const timeline = await buildRunTimeline(REAL_RUN_DIR);
    const trace = buildRunWorldTrace({
      runId: timeline.runId,
      runName: timeline.runId,
      world: { networkId: "office_lab", roomId: "office-room", members: ["eleanor", "sam"] },
      timeline,
    });

    assert.equal(trace.version, "viewer.trace.v1");
    assert.equal(trace.rooms.length, 1);
    assert.equal(trace.rooms[0]!.id, "room:office_lab:office-room");
    assert.equal(trace.rooms[0]!.access_hint, NO_PLACE_CAPTION);
    assert.deepEqual(trace.rooms[0]!.members.slice().sort(), ["eleanor", "sam"]);

    assert.equal(trace.agents.length, 2);
    assert.ok(trace.agents.every((agent) => agent.label_hint === "heuristic"));

    assert.equal(trace.presence.length, 0);
    assert.equal(trace.corridors.length, 0);
    assert.equal(trace.ledger_facts.length, timeline.events.length);
    assert.equal(trace.ledger_facts[0]!.tick, 0);
    assert.ok(trace.ledger_facts.every((fact, index) => fact.tick === index));
  });

  it("lays out an explicit multi-room `rooms` list side by side, each with its own stated members (no cross-room fallback)", async () => {
    const timeline = await buildRunTimeline(JUNGIAN_GOLDEN_DIR);
    const trace = buildRunWorldTrace({
      runId: timeline.runId,
      runName: timeline.runId,
      rooms: [
        { networkId: "psyche-floor", roomId: "commons", members: ["luna-representative", "selene-representative"] },
        { networkId: "luna_inner", roomId: "luna-council", members: ["luna-animus", "luna-representative", "luna-shadow"] },
      ],
      timeline,
    });

    assert.equal(trace.rooms.length, 2);
    assert.equal(trace.rooms[0]!.id, "room:psyche-floor:commons");
    assert.deepEqual(trace.rooms[0]!.scene, [0, 0, 0]);
    assert.equal(trace.rooms[1]!.id, "room:luna_inner:luna-council");
    // Distinct x-offset so the two rooms don't render stacked at one origin.
    assert.ok(trace.rooms[1]!.scene[0] > trace.rooms[0]!.scene[0]);
    // Union of both rooms' agents, not every agent in the run (selene-animus/-shadow are excluded).
    assert.deepEqual(trace.agents.map((agent) => agent.id).sort(), [
      "luna-animus", "luna-representative", "luna-shadow", "selene-representative",
    ]);
  });

  it("an explicit room with no stated members gets none (multi-room shape never borrows every timeline agent)", async () => {
    const timeline = await buildRunTimeline(JUNGIAN_GOLDEN_DIR);
    const trace = buildRunWorldTrace({
      runId: timeline.runId,
      runName: timeline.runId,
      rooms: [
        { networkId: "psyche-floor", roomId: "commons" },
        { networkId: "luna_inner", roomId: "luna-council", members: ["luna-animus"] },
      ],
      timeline,
    });
    assert.deepEqual(trace.rooms[0]!.members, []);
    assert.deepEqual(trace.agents.map((agent) => agent.id), ["luna-animus"]);
  });

  it("projects a composed spatial world while retaining its recursive head", async () => {
    const [timeline, spatialWorld] = await Promise.all([
      buildRunTimeline(OFFICE_PSYCHE_GOLDEN_DIR),
      readRunSpatialWorld(OFFICE_PSYCHE_GOLDEN_DIR),
    ]);
    assert.ok(spatialWorld);
    const trace = buildRunWorldTrace({
      runId: timeline.runId,
      runName: "office-psyche",
      spatialWorld,
      timeline,
    });

    assert.deepEqual(trace.rooms.map((room) => room.id), [
      "room:office-psyche:home",
      "room:office-psyche:office",
    ]);
    assert.deepEqual(trace.corridors.map((corridor) => ({
      id: corridor.id,
      from: corridor.from_room,
      to: corridor.to_room,
      travelTicks: corridor.travel_ticks,
    })), [{
      id: "office_home",
      from: "room:office-psyche:office",
      to: "room:office-psyche:home",
      travelTicks: 2,
    }]);
    assert.deepEqual(trace.agents.map((agent) => agent.id), ["eleanor", "mara", "sam"]);
    assert.deepEqual(trace.presence.filter((event) => event.actor === "eleanor"), [
      { actor: "eleanor", room: "room:office-psyche:office", tick: 0, type: "presence.arrived" },
      {
        actor: "eleanor",
        from_room: "room:office-psyche:office",
        path_id: "office_home",
        tick: 3,
        to_room: "room:office-psyche:home",
        type: "presence.departed",
      },
      {
        actor: "eleanor",
        arrived_at: 5,
        from_room: "room:office-psyche:office",
        path_id: "office_home",
        started_at: 3,
        tick: 3,
        to_room: "room:office-psyche:home",
        type: "presence.in_transit",
      },
      { actor: "eleanor", room: "room:office-psyche:home", tick: 5, type: "presence.arrived" },
    ]);
    assert.deepEqual(trace.spatial_samples[3], {
      occupancy: {
        "room:office-psyche:home": ["mara"],
        "room:office-psyche:office": ["sam"],
      },
      tick: 3,
      transit: [{
        agent: "eleanor",
        from_room: "room:office-psyche:office",
        path_id: "office_home",
        ticks_remaining: 2,
        to_room: "room:office-psyche:home",
      }],
    });
    assert.deepEqual(
      trace.ledger_facts.filter((fact) => fact.actor === "eleanor" && fact.type.startsWith("presence.")).map((fact) => ({
        type: fact.type,
        tick: fact.tick,
        target: fact.target,
      })),
      [
        { type: "presence.arrived", tick: 0, target: "office" },
        { type: "presence.left", tick: 3, target: "office" },
        { type: "presence.arrived", tick: 5, target: "home" },
      ],
    );

    const membranes = buildMembraneInteriorWorlds(timeline.membranes ?? [], timeline);
    assert.equal(membranes[0]?.ref, "team:eleanor-mind");
    assert.equal(membranes[0]?.representative, "agent:eleanor");
    assert.equal(membranes[0]?.interiorWorld?.rooms[0]?.id, "room:eleanor_inner:eleanor-council");
  });

  it("keeps every pre-spatial golden on the informational-anchor gate", async () => {
    const dirs = [
      path.resolve(here, "..", "..", "fixtures", "observe", "office-sim-golden"),
      path.resolve(here, "..", "..", "fixtures", "observe", "office-secret-v0-golden"),
      JUNGIAN_GOLDEN_DIR,
    ];
    assert.deepEqual(await Promise.all(dirs.map(readRunSpatialWorld)), [undefined, undefined, undefined]);
  });
});

describe("buildMembraneInteriorWorlds", () => {
  it("builds a viewer.trace.v1 mini-map per membrane, scoped to exactly its own interior room and members", async () => {
    const timeline = await buildRunTimeline(JUNGIAN_GOLDEN_DIR);
    const withInteriorWorlds = buildMembraneInteriorWorlds(timeline.membranes ?? [], timeline);

    assert.equal(withInteriorWorlds.length, 2);
    const luna = withInteriorWorlds.find((membrane) => membrane.ref === "team:luna");
    assert.ok(luna?.interiorWorld, "expected team:luna to carry an interiorWorld trace");
    assert.equal(luna!.interiorWorld!.version, "viewer.trace.v1");
    assert.equal(luna!.interiorWorld!.rooms.length, 1);
    assert.equal(luna!.interiorWorld!.rooms[0]!.id, "room:luna_inner:luna-council");
    assert.deepEqual(luna!.interiorWorld!.rooms[0]!.members.slice().sort(), [
      "luna-animus", "luna-representative", "luna-shadow",
    ]);
    // The interior trace never leaks selene's agents.
    assert.ok(!luna!.interiorWorld!.agents.some((agent) => agent.id.startsWith("selene")));

    const selene = withInteriorWorlds.find((membrane) => membrane.ref === "team:selene");
    assert.equal(selene?.interiorWorld?.rooms[0]?.id, "room:selene_inner:selene-council");
  });

  it("passes a membrane through unchanged when it has no parseable interior room ref", () => {
    const timeline = { version: "simfile.run-timeline.v1" as const, runId: "run-x", events: [], elements: [] };
    const membranes = [{
      ref: "team:empty",
      label: "empty",
      representative: "agent:lead",
      interiorRooms: [],
      members: ["agent:lead"],
    }];
    const result = buildMembraneInteriorWorlds(membranes, timeline);
    assert.deepEqual(result, membranes);
  });
});
