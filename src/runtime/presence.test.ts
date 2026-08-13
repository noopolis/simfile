import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseSimfileSource } from "../schema/parse.js";
import { runSimfileTrace } from "./trace-run.js";

const simfile = parseSimfileSource(`
simfile_version: "0.1"
name: presence-runtime-world
clock:
  seed: presence-runtime
  tick: 1m
places:
  atrium:
    label: Shared Atrium
  plaza:
    kind: square
  vacant: {}
presence:
  zeta: plaza
  alpha: atrium
`, { path: "Simfile.yaml" }).simfile;

describe("runtime presence", () => {
  it("emits canonical arrival events at tick zero", () => {
    const trace = runSimfileTrace(simfile, {
      runId: "presence-run",
      seed: "presence-runtime",
      ticks: 2
    });
    const arrivals = trace.events.filter((event) => event.kind === "presence.arrived");

    assert.equal(arrivals.length, 2);
    assert.deepEqual(arrivals.map((event) => event.payload), [
      { agent: "alpha", place: "atrium", tick: 0 },
      { agent: "zeta", place: "plaza", tick: 0 }
    ]);
    assert.deepEqual(arrivals.map((event) => ({
      actor: event.actor,
      target: event.target,
      scope: event.scope,
      stream: event.emitter?.stream_id,
      causes: event.cause_event_ids
    })), [
      {
        actor: "alpha",
        target: "atrium",
        scope: "atrium",
        stream: "world",
        causes: ["simfile:presence-run:1"]
      },
      {
        actor: "zeta",
        target: "plaza",
        scope: "plaza",
        stream: "world",
        causes: ["simfile:presence-run:1"]
      }
    ]);
  });

  it("exposes stable occupancy for every place on every tick sample", () => {
    const trace = runSimfileTrace(simfile, {
      runId: "occupancy-run",
      seed: "presence-runtime",
      ticks: 2
    });

    assert.deepEqual(trace.samples.map((sample) => sample.occupancy), [
      { atrium: ["alpha"], plaza: ["zeta"], vacant: [] },
      { atrium: ["alpha"], plaza: ["zeta"], vacant: [] }
    ]);
  });

  it("moves through frozen transit and arrives after exactly travel_ticks", () => {
    const movement = parseSimfileSource(`
simfile_version: "0.1"
name: timed-movement-world
clock:
  seed: timed-movement
  tick: 1m
places:
  origin: {}
  destination: {}
routes:
  passage:
    from: origin
    to: destination
    travel_ticks: 3
presence:
  alpha: origin
variables:
  elapsed:
    scope: global
    initial: 0
    range: 0..10
generators:
  advance:
    kind: deterministic
    variable: elapsed
    delta: 1
rules:
  depart:
    fire: once
    when: { variable: elapsed, above: 0.5 }
    do:
      - { action: move, agent: alpha, to: destination }
  retry-while-moving:
    fire: once
    when: { variable: elapsed, above: 1.5 }
    do:
      - { action: move, agent: alpha, to: destination }
      - { action: moltnet:dm, to: "agent:alpha", content: "should be ignored" }
`, { path: "Simfile.yaml" }).simfile;

    const trace = runSimfileTrace(movement, {
      runId: "timed-movement-run",
      seed: "timed-movement",
      ticks: 5
    });
    const left = trace.events.filter((event) => event.kind === "presence.left");
    const arrived = trace.events.filter((event) => event.kind === "presence.arrived");

    assert.deepEqual(left.map((event) => event.payload), [
      { agent: "alpha", place: "origin", tick: 0 }
    ]);
    assert.deepEqual(arrived.map((event) => event.payload), [
      { agent: "alpha", place: "origin", tick: 0 },
      { agent: "alpha", place: "destination", tick: 3 }
    ]);
    assert.deepEqual(trace.samples.map((sample) => sample.occupancy), [
      { destination: [], origin: [] },
      { destination: [], origin: [] },
      { destination: [], origin: [] },
      { destination: ["alpha"], origin: [] },
      { destination: ["alpha"], origin: [] }
    ]);
    assert.deepEqual(trace.samples.map((sample) => sample.transit), [
      [{ agent: "alpha", from: "origin", to: "destination", ticksRemaining: 3 }],
      [{ agent: "alpha", from: "origin", to: "destination", ticksRemaining: 2 }],
      [{ agent: "alpha", from: "origin", to: "destination", ticksRemaining: 1 }],
      [],
      []
    ]);
    assert.equal(trace.events.filter((event) => event.kind === "world.dm").length, 0);
    assert.equal(trace.events.some((event) => event.kind === "rule.fired"
      && (event.payload as Record<string, unknown>).rule === "retry-while-moving"), true);
  });
});
