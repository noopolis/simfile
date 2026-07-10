import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseClockSpec, resolveClockState } from "./clock.js";
import { runSimfileTrace, scanTraceMarkers, serializeCanonicalEvents } from "./trace.js";
import { buildViewerTrace } from "./viewer-trace.js";
import { parseSimfileSource } from "../schema/parse.js";

const parse = (source: string) => parseSimfileSource(source, { path: "Simfile.yaml" }).simfile;

const payloadObject = (payload: unknown): Record<string, unknown> => {
  assert.equal(typeof payload, "object");
  assert.notEqual(payload, null);
  assert.equal(Array.isArray(payload), false);
  return payload as Record<string, unknown>;
};

describe("clock phase resolution", () => {
  it("builds ticked sim time and rotates through phases by day boundary", () => {
    const clock = parseClockSpec({
      tick: "1m",
      sim_per_tick: "1m",
      seed: "seed",
      phases: {
        midnight: "00:00",
        on: "00:01",
        off: "00:02"
      }
    });

    const t0 = resolveClockState(clock, 0);
    const t1 = resolveClockState(clock, 1);
    const t61 = resolveClockState(clock, 61);
    const t1440 = resolveClockState(clock, 1440);
    const t1441 = resolveClockState(clock, 1441);
    const t1442 = resolveClockState(clock, 1442);

    assert.equal(t0.phase, "midnight");
    assert.equal(t1.phase, "on");
    assert.equal(t61.phase, "off");
    assert.equal(t1440.phase, "midnight");
    assert.equal(t1441.phase, "on");
    assert.equal(t1442.phase, "off");
  });
});

describe("trace generation", () => {
  it("applies deterministic generators and clamps ranges", () => {
    const simfile = parse(`
simfile_version: "0.1"
name: deterministic-clip-world
clock:
  seed: deterministic-clip
  tick: 1m
variables:
  pressure:
    scope: global
    initial: 0.5
    range: 0..1
generators:
  pressure_rise:
    kind: deterministic
    variable: pressure
    delta: 0.3
`);

    const result = runSimfileTrace(simfile, { runId: "run-clamp", seed: "seed-a", ticks: 4 });
    assert.equal(result.variables.pressure, 1);
    assert.equal(result.events.length, 4);
    assert.equal(result.events[0]?.kind, "clock.sync");
    assert.equal(result.events[0]?.sim_time, 0);
    assert.equal(result.events[3]?.kind, "clock.sync");
    assert.equal(result.events[3]?.sim_time, 180);
  });

  it("runs generators and rules in lexicographic id order", () => {
    const simfile = parse(`
simfile_version: "0.1"
name: order-world
clock:
  seed: order
  tick: 1m
variables:
  value:
    scope: global
    initial: 1
    range: 0..100
generators:
  z_double:
    kind: deterministic
    variable: value
    delta_eq: value
  a_set:
    kind: deterministic
    variable: value
    set_eq: "2"
rules:
  z_last:
    when:
      event: clock.sync
    do:
      - action: variable:set
        variable: value
        value: 7
  a_first:
    when:
      event: clock.sync
    do:
      - action: variable:set
        variable: value
        value: 5
`);

    const result = runSimfileTrace(simfile, { runId: "run-order", seed: "seed-order", ticks: 1 });
    assert.equal(result.variables.value, 7);
  });

  it("recomputes derived variables after generators before rules", () => {
    const simfile = parse(`
simfile_version: "0.1"
name: derived-rule-world
clock:
  seed: derived-order
  tick: 1m
variables:
  base:
    scope: global
    initial: 0
    range: 0..10
  doubled:
    scope: global
    range: 0..20
    derive:
      eq: base * 2
generators:
  base_rise:
    kind: deterministic
    variable: base
    delta: 3
rules:
  observe_doubled:
    when:
      variable: doubled
      above: 5
    do:
      - action: wake:recommend
        to: room:office-floor:case-warroom
`);

    const result = runSimfileTrace(simfile, { runId: "run-derived", seed: "seed-derived", ticks: 1 });
    assert.equal(result.variables.doubled, 6);
    assert.equal(result.events.some((event) => event.kind === "wake.recommended"), true);
  });

  it("applies seeded stochastic generators deterministically", () => {
    const simfile = parse(`
simfile_version: "0.1"
name: stochastic-world
clock:
  seed: stochastic-world
  tick: 1m
variables:
  noise:
    scope: global
    range: 0..1
generators:
  noise:
    kind: stochastic
    variable: noise
    uniform: [0, 1]
`);

    const first = runSimfileTrace(simfile, { runId: "run-stoch", seed: "same-seed", ticks: 2 });
    const second = runSimfileTrace(simfile, { runId: "run-stoch", seed: "same-seed", ticks: 2 });
    assert.deepEqual(first.variables, second.variables);
    assert.deepEqual(serializeCanonicalEvents(first.events), serializeCanonicalEvents(second.events));
  });

  it("respects once and per_crossing rule firing semantics", () => {
    const simfile = parse(`
simfile_version: "0.1"
name: crossing-world
clock:
  seed: crossing
  tick: 1m
  phases:
    midnight: "00:00"
    on: "00:01"
    off: "00:02"
rules:
  once_rule:
    fire: once
    when:
      phase: on
    do:
      - action: wake:recommend
        to: room:office-floor:case-warroom
  cross_rule:
    fire: per_crossing
    when:
      phase: on
    do:
      - action: wake:recommend
        to: room:office-floor:case-warroom
`);

    const result = runSimfileTrace(simfile, { runId: "run-cross", seed: "seed-x", ticks: 1442 });
    const onceFires = result.events.filter((event) => event.kind === "rule.fired" && event.actor === "once_rule").length;
    const crossFires = result.events.filter((event) => event.kind === "rule.fired" && event.actor === "cross_rule").length;
    assert.equal(onceFires, 1);
    assert.equal(crossFires, 2);
  });

  it("lowers rule actions to world and wake events with canonical payloads", () => {
    const simfile = parse(`
simfile_version: "0.1"
name: lowering-world
clock:
  seed: lowering
  tick: 1m
variables:
  mood:
    scope: global
    initial: 2
    range: 0..10
rules:
  announce:
    fire: once
    when:
      event: clock.sync
    do:
      - action: moltnet:message
        to: room:office-floor:case-warroom
        content: "Mood is {mood}"
      - action: moltnet:dm
        to: agent:alice
        content: "Tell {mood} to agent."
      - action: wake:recommend
        to: room:office-floor:case-warroom
      - action: variable:set
        variable: mood
        value: 6
`);

    const result = runSimfileTrace(simfile, { runId: "run-lower", seed: "lowering", ticks: 1 });
    const kinds = result.events.filter((event) => event.kind !== "clock.sync").map((event) => event.kind).sort();
    assert.deepEqual(kinds, ["rule.fired", "wake.recommended", "world.dm", "world.message"]);

    const message = result.events.find((event) => event.kind === "world.message");
    const dm = result.events.find((event) => event.kind === "world.dm");
    assert.equal(payloadObject(message?.payload).action, "moltnet:message");
    assert.equal(payloadObject(message?.payload).content, "Mood is 2.000000");
    assert.equal(payloadObject(dm?.payload).content, "Tell 2.000000 to agent.");
    assert.equal(result.variables.mood, 6);
  });

  it("scans marker aliases from trace events", () => {
    const simfile = parse(`
simfile_version: "0.1"
name: marker-world
clock:
  seed: marker
  tick: 1m
rules:
  announce:
    when:
      event: clock.sync
    do:
      - action: moltnet:message
        to: room:office-floor:case-warroom
        content: "Tenant Rosa Delgado was found."
markers:
  tenant_name:
    text:
      - "Rosa Delgado"
    mode: containment
    scopes:
      - room:office-floor:case-warroom
      - team:office
`);

    const result = runSimfileTrace(simfile, { runId: "run-marker", seed: "marker", ticks: 1 });
    const hits = scanTraceMarkers(result.events, result.events.reduce((memo, event) => memo, simfile.markers));
    assert.equal(hits.tenant_name.length, 1);
    assert.equal(hits.tenant_name[0]?.scope, "room:office-floor:case-warroom");
  });

  it("emits deterministic canonical event payload strings", () => {
    const simfile = parse(`
simfile_version: "0.1"
name: canonical-world
clock:
  seed: canonical
  tick: 1m
variables:
  value:
    scope: global
    initial: 0
    range: 0..10
generators:
  bump:
    kind: deterministic
    variable: value
    delta: 1
rules:
  notify:
    when:
      event: clock.sync
    do:
      - action: wake:recommend
        to: room:office-floor:case-warroom
`);

    const left = runSimfileTrace(simfile, { runId: "run-canon", seed: "canon", ticks: 2 });
    const right = runSimfileTrace(simfile, { runId: "run-canon", seed: "canon", ticks: 2 });

    const leftLines = serializeCanonicalEvents(left.events);
    const rightLines = serializeCanonicalEvents(right.events);
    assert.deepEqual(leftLines, rightLines);
    assert.equal(JSON.parse(leftLines[0] ?? "{}").event_id, "simfile:run-canon:1");
    assert.equal(leftLines.length, rightLines.length);
  });

  it("stamps every event with the simfile causal envelope and wires rule causation", () => {
    const simfile = parse(`
simfile_version: "0.1"
name: causal-world
clock:
  seed: causal
  tick: 1m
rules:
  announce:
    fire: once
    when:
      event: clock.sync
    do:
      - action: moltnet:message
        to: room:office-floor:case-warroom
        content: "hi"
`);

    const result = runSimfileTrace(simfile, { runId: "run-causal", seed: "causal", ticks: 1 });
    const clockSync = result.events.find((event) => event.kind === "clock.sync")!;
    const ruleFired = result.events.find((event) => event.kind === "rule.fired")!;
    const message = result.events.find((event) => event.kind === "world.message")!;

    for (const event of result.events) {
      assert.equal(event.version, "noopolis.causal-event.v1");
      assert.equal(event.run_id, "run-causal");
      assert.equal(event.event_id, `simfile:run-causal:${event.emitter?.seq}`);
      assert.deepEqual(event.emitter && { system: event.emitter.system, stream_id: event.emitter.stream_id }, {
        system: "simfile",
        stream_id: "world"
      });
      assert.equal(event.principal_id, "system:simfile.world");
      assert.equal(Array.isArray(event.cause_event_ids), true);
    }

    assert.deepEqual(clockSync.cause_event_ids, []);
    assert.deepEqual(ruleFired.cause_event_ids, [clockSync.event_id]);
    assert.deepEqual(message.cause_event_ids, [ruleFired.event_id]);

    const messagePayload = payloadObject(message.payload);
    assert.equal(messagePayload.act_id, `run-causal:act:${message.emitter?.seq}`);
    assert.equal(messagePayload.action, "moltnet:message");
    assert.equal(messagePayload.actor, "@world");
    assert.equal(messagePayload.target, "room:office-floor:case-warroom");
    assert.equal(messagePayload.scope, "room:office-floor:case-warroom");
    assert.equal(messagePayload.sim_time, message.sim_time);
    assert.equal(messagePayload.provenance, "mechanical");
    assert.equal(messagePayload.value, "hi");
  });

  it("builds viewer traces with canonical event kinds and heuristic agent labels", () => {
    const simfile = parse(`
simfile_version: "0.1"
name: viewer-contract-world
clock:
  seed: viewer-contract
  tick: 1m
variables:
  value:
    scope: room:office-floor:case-warroom
    initial: 0
    range: 0..10
rules:
  notify:
    when:
      event: clock.sync
    do:
      - action: moltnet:message
        to: room:office-floor:case-warroom
        content: "Room message."
      - action: moltnet:dm
        to: agent:alice
        content: "Private note."
markers:
  room_marker:
    text:
      - "Room message"
    mode: containment
    scopes:
      - room:office-floor:case-warroom
`);

    const trace = runSimfileTrace(simfile, { runId: "run-viewer", seed: "viewer", ticks: 1 });
    const viewerTrace = buildViewerTrace(simfile, trace, [], []);
    const factKinds = new Set(viewerTrace.ledger_facts.map((fact) => fact.type));
    assert.ok(factKinds.has("clock.sync"));
    assert.ok(factKinds.has("world.message"));
    assert.ok(factKinds.has("world.dm"));
    assert.ok(factKinds.has("marker.seen"));
    const dmFact = viewerTrace.ledger_facts.find((fact) => fact.type === "world.dm");
    assert.equal(dmFact?.kind, "world.dm");
    assert.equal(dmFact?.provenance, "mechanical");
    assert.equal(typeof dmFact?.event_id, "string");
    assert.equal(typeof dmFact?.sim_time, "number");
    assert.equal(viewerTrace.agents.find((agent) => agent.id === "alice")?.label_hint, "heuristic");
  });
});
