import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseSimfileSource } from "../schema/parse.js";
import { runSimfileTrace } from "./trace.js";
import { buildViewerTrace } from "./viewer-trace.js";

const parse = (source: string) =>
  parseSimfileSource(source, { path: "Simfile.yaml" }).simfile;
const payloadObject = (payload: unknown): Record<string, unknown> => {
  assert.equal(typeof payload, "object");
  assert.notEqual(payload, null);
  assert.equal(Array.isArray(payload), false);
  return payload as Record<string, unknown>;
};

describe("trace causal envelopes and viewer projections", () => {
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

  it("threads the referenced variable id onto rule.fired and every world-effect event a variable-gated rule emits (viewer's variable storyline join)", () => {
    const simfile = parse(`
simfile_version: "0.1"
name: variable-storyline-world
clock:
  seed: variable-storyline
  tick: 1m
variables:
  filing_pressure:
    scope: room:office-floor:case-warroom
    initial: 0.9
    range: 0..1
rules:
  pressure_alert:
    fire: once
    when:
      variable: filing_pressure
      above: 0.85
    do:
      - action: moltnet:message
        to: room:office-floor:case-warroom
        content: "Deadline pressure is high."
  kickoff:
    fire: once
    when:
      event: clock.sync
    do:
      - action: moltnet:message
        to: room:office-floor:case-warroom
        content: "Observation notice."
`);

    const result = runSimfileTrace(simfile, { runId: "run-var-storyline", seed: "seed", ticks: 1 });

    const pressureFired = result.events.find((event) => event.kind === "rule.fired" && event.actor === "pressure_alert")!;
    assert.deepEqual(payloadObject(pressureFired.payload).variables, ["filing_pressure"]);

    const pressureMessage = result.events.find((event) =>
      event.kind === "world.message"
        && payloadObject(event.payload).rule === "pressure_alert")!;
    assert.deepEqual(payloadObject(pressureMessage.payload).variables, ["filing_pressure"]);

    // A rule gated on a phase/event condition (no variable in its `when:`)
    // must not grow a `variables` key at all — never a fabricated empty
    // array, and byte-identical to every rule.fired/world.message event
    // emitted before this field existed.
    const kickoffFired = result.events.find((event) => event.kind === "rule.fired" && event.actor === "kickoff")!;
    assert.equal("variables" in payloadObject(kickoffFired.payload), false);
    const kickoffMessage = result.events.find((event) =>
      event.kind === "world.message" && payloadObject(event.payload).rule === "kickoff")!;
    assert.equal("variables" in payloadObject(kickoffMessage.payload), false);
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
