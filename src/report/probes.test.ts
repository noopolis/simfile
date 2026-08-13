import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProbeArtifact, ProbeDefinition } from "./probes.js";
import { evaluateProbe } from "./probes.js";
import type { LedgerEvent } from "../ledger/markers.js";

const events: LedgerEvent[] = [
  { event_id: "run:1", kind: "world.message", sim_time: 0, scope: "room:a", actor: "system" },
  { event_id: "run:2", kind: "world.dm", sim_time: 1, scope: "room:a", actor: "user" },
  { event_id: "run:3", kind: "marker.seen", sim_time: 2, scope: "room:a", actor: "system" },
  { event_id: "run:4", kind: "marker.seen", sim_time: 3, scope: "room:b", actor: "system" }
];

const traceArtifact: ProbeArtifact = {
  events: [
    {
      event_id: "tick:0",
      kind: "clock.sync",
      sim_time: 0,
      scope: "global",
      actor: "world",
      target: "global",
      payload: { tick: 0, sim_time: 0, phase: "morning" }
    },
    {
      event_id: "run:10",
      kind: "world.message",
      sim_time: 0,
      scope: "room:a",
      actor: "system",
      target: "room:a"
    },
    {
      event_id: "tick:1",
      kind: "clock.sync",
      sim_time: 60,
      scope: "global",
      actor: "world",
      target: "global",
      payload: { tick: 1, sim_time: 60, phase: "workday" }
    },
    {
      event_id: "run:11",
      kind: "world.dm",
      sim_time: 60,
      scope: "room:a",
      actor: "deadline_bites",
      target: "room:a"
    },
    {
      event_id: "tick:2",
      kind: "clock.sync",
      sim_time: 120,
      scope: "global",
      actor: "world",
      target: "global",
      payload: { tick: 2, sim_time: 120, phase: "workday" }
    },
    {
      event_id: "tick:3",
      kind: "clock.sync",
      sim_time: 180,
      scope: "global",
      actor: "world",
      target: "global",
      payload: { tick: 3, sim_time: 180, phase: "evening" }
    }
  ],
  samples: [
    { evidence_id: "tick:0", tick: 0, sim_time: 0, phase: "morning", variables: { pressure: 0.4, hall_heat: 5 } },
    { evidence_id: "tick:1", tick: 1, sim_time: 60, phase: "workday", variables: { pressure: 0.86, hall_heat: 4 } },
    { evidence_id: "tick:2", tick: 2, sim_time: 120, phase: "workday", variables: { pressure: 0.91, hall_heat: 2 } },
    { evidence_id: "tick:3", tick: 3, sim_time: 180, phase: "evening", variables: { pressure: 0.92, hall_heat: 2 } }
  ]
};

describe("evaluateProbe", () => {
  it("counts event matches for at_least", () => {
    const probe: ProbeDefinition = {
      when: { event: "marker.seen" },
      expect: { at_least: 2 }
    };
    const result = evaluateProbe("marker_seen_once", events, probe);
    assert.equal(result.passed, true);
    assert.equal(result.count, 2);
    assert.deepEqual(result.evidence, ["run:3", "run:4"]);
  });

  it("supports all/any composition", () => {
    const probe: ProbeDefinition = {
      when: { all: [{ event: "world.message" }, { actor: "system", event: "world.message" }] },
      expect: { at_least: 1 }
    };
    const result = evaluateProbe("event_all", events, probe);
    assert.equal(result.passed, true);
    assert.equal(result.count, 1);
  });

  it("supports any composition", () => {
    const probe: ProbeDefinition = {
      when: { any: [{ event: "world.message" }, { event: "clock.sync" }] },
      expect: { at_least: 1 }
    };
    const result = evaluateProbe("event_any", events, probe);
    assert.equal(result.passed, true);
    assert.equal(result.count, 1);
  });

  it("applies after + within windows", () => {
    const probe: ProbeDefinition = {
      when: { event: "marker.seen", scope: "room:b" },
      after: { event: "world.message" },
      within: "10s",
      expect: { at_least: 1 }
    };
    const result = evaluateProbe("leak_after_message", events, probe);
    assert.equal(result.passed, true);
    assert.equal(result.count, 1);
  });

  it("supports at_end", () => {
    const probe: ProbeDefinition = {
      when: { event: "marker.seen" },
      expect: { at_end: true }
    };
    const result = evaluateProbe("last_marker", events, probe);
    assert.equal(result.passed, true);
  });

  it("supports at_most", () => {
    const probe: ProbeDefinition = {
      when: { event: "rule.fired" },
      expect: { at_most: 0 }
    };
    const result = evaluateProbe("no_rule_fired", events, probe);
    assert.equal(result.passed, true);
    assert.equal(result.count, 0);
  });

  it("evaluates phase probes from trace artifacts", () => {
    const probe: ProbeDefinition = {
      when: { phase: "workday" },
      expect: { at_least: 2 }
    };
    const result = evaluateProbe("phase_workday", traceArtifact, probe);
    assert.equal(result.passed, true);
    assert.equal(result.count, 2);
    assert.deepEqual(result.evidence, ["tick:1", "tick:2"]);
  });

  it("evaluates variable thresholds and composition from samples", () => {
    const probe: ProbeDefinition = {
      when: {
        all: [
          { phase: "workday" },
          { variable: "pressure", above: 0.85 },
          { not: { variable: "hall_heat", above: 3 } }
        ]
      },
      expect: { at_least: 1 }
    };
    const result = evaluateProbe("pressure_peak", traceArtifact, probe);
    assert.equal(result.passed, true);
    assert.equal(result.count, 1);
    assert.deepEqual(result.evidence, ["tick:2"]);
  });

  it("supports bounded after windows between events and state samples", () => {
    const probe: ProbeDefinition = {
      when: { variable: "pressure", above: 0.9, for: "60s" },
      after: { event: "world.dm", target: "room:a" },
      within: "2m",
      expect: { at_least: 1 }
    };
    const result = evaluateProbe("pressure_after_wake", traceArtifact, probe);
    assert.equal(result.passed, true);
    assert.equal(result.count, 1);
    assert.deepEqual(result.evidence, ["tick:3"]);
  });
});
