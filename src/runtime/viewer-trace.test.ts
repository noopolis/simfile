import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseSimfileSource } from "../schema/parse.js";
import { runSimfileTrace } from "./trace-run.js";
import { buildViewerTrace } from "./viewer-trace.js";

const simfile = parseSimfileSource(`
simfile_version: "0.1"
name: viewer-commute
clock:
  seed: viewer-commute
  tick: 1h
places:
  office: { label: Office, kind: room }
  home: { label: Home, kind: room }
routes:
  office_home:
    from: office
    to: home
    travel_ticks: 2
    direction: bidirectional
presence:
  eleanor: office
  sam: office
  mara: home
variables:
  hour:
    scope: room:day:floor
    initial: 9
    range: 9..18
generators:
  advance: { kind: deterministic, variable: hour, delta: 1 }
rules:
  leave:
    fire: once
    when: { variable: hour, above: 10 }
    do: [{ action: move, agent: eleanor, to: home }]
`, { path: "Simfile" }).simfile;

describe("buildViewerTrace spatial projection", () => {
  it("projects places, routes, agents, presence, and tick samples with qualified room ids", () => {
    const runtime = runSimfileTrace(simfile, { runId: "viewer-commute-run", seed: "viewer-commute", ticks: 5 });
    const trace = buildViewerTrace(simfile, runtime, [], []);

    assert.deepEqual(trace.rooms.map((room) => ({ id: room.id, label: room.label, kind: room.kind })), [
      { id: "room:viewer-commute:home", label: "Home", kind: "room" },
      { id: "room:viewer-commute:office", label: "Office", kind: "room" },
      { id: "room:day:floor", label: "floor", kind: "room" }
    ]);
    assert.deepEqual(trace.corridors.map((corridor) => ({
      id: corridor.id,
      from: corridor.from_room,
      to: corridor.to_room,
      ticks: corridor.travel_ticks
    })), [{
      id: "office_home",
      from: "room:viewer-commute:office",
      to: "room:viewer-commute:home",
      ticks: 2
    }]);
    assert.deepEqual(trace.agents.map((agent) => agent.id), ["eleanor", "mara", "sam"]);
    assert.ok(trace.agents.every((agent) => agent.label_hint === undefined));

    assert.deepEqual(trace.presence.filter((event) => event.actor === "eleanor"), [
      { actor: "eleanor", room: "room:viewer-commute:office", tick: 0, type: "presence.arrived" },
      {
        actor: "eleanor",
        from_room: "room:viewer-commute:office",
        path_id: "office_home",
        tick: 1,
        to_room: "room:viewer-commute:home",
        type: "presence.departed"
      },
      {
        actor: "eleanor",
        arrived_at: 3,
        from_room: "room:viewer-commute:office",
        path_id: "office_home",
        started_at: 1,
        tick: 1,
        to_room: "room:viewer-commute:home",
        type: "presence.in_transit"
      },
      { actor: "eleanor", room: "room:viewer-commute:home", tick: 3, type: "presence.arrived" }
    ]);
    assert.deepEqual(trace.spatial_samples[1], {
      occupancy: {
        "room:viewer-commute:home": ["mara"],
        "room:viewer-commute:office": ["sam"]
      },
      tick: 1,
      transit: [{
        agent: "eleanor",
        from_room: "room:viewer-commute:office",
        path_id: "office_home",
        ticks_remaining: 2,
        to_room: "room:viewer-commute:home"
      }]
    });
    assert.deepEqual(
      trace.ledger_facts.filter((fact) => fact.kind.startsWith("presence.")).map((fact) => fact.type),
      ["presence.arrived", "presence.arrived", "presence.arrived", "presence.left", "presence.arrived"]
    );
  });
});
