import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseSimfileSource } from "./parse.js";

const parse = (source: string) => parseSimfileSource(source, { path: "Simfile.yaml" });

describe("validateSimfileSemantics", () => {
  it("rejects unknown variables in when blocks", () => {
    assert.throws(() => parse(`
simfile_version: "0.1"
name: office-world
clock:
  seed: office
  tick: 1m
rules:
  pressure_alarm:
    when:
      variable: missing_pressure
      above: 0.8
    do:
      - action: moltnet:message
        to: room:office-floor:case-warroom
        content: "Alarm"
`), /rule pressure_alarm when references unknown variable missing_pressure/);
  });

  it("rejects unknown phases in probe when blocks", () => {
    assert.throws(() => parse(`
simfile_version: "0.1"
name: office-world
clock:
  seed: office
  tick: 1m
  phases:
    workday: "09:00"
probes:
  after_hours:
    when:
      phase: night
    expect:
      at_least: 1
`), /probe after_hours when references unknown phase night/);
  });

  it("rejects unknown variables in rule placeholders", () => {
    assert.throws(() => parse(`
simfile_version: "0.1"
name: office-world
clock:
  seed: office
  tick: 1m
variables:
  pressure:
    scope: global
    range: 0..1
rules:
  pressure_alarm:
    when:
      variable: pressure
      above: 0.8
    do:
      - action: moltnet:message
        to: room:office-floor:case-warroom
        content: "Alarm at {missing_pressure}"
`), /rule pressure_alarm action moltnet:message placeholder references unknown variable missing_pressure/);
  });

  it("rejects unknown derive dependencies", () => {
    assert.throws(() => parse(`
simfile_version: "0.1"
name: office-world
clock:
  seed: office
  tick: 1m
variables:
  pressure:
    scope: global
    range: 0..1
  social_weather:
    scope: global
    range: 0..1
    derive:
      eq: pressure + rumor_heat
`), /variable social_weather derive\.eq references unknown variable rumor_heat/);
  });

  it("rejects unknown generator expression dependencies", () => {
    assert.throws(() => parse(`
simfile_version: "0.1"
name: office-world
clock:
  seed: office
  tick: 1m
variables:
  pressure:
    scope: global
    range: 0..1
generators:
  pressure_ramp:
    kind: deterministic
    variable: pressure
    delta_eq: rumor_heat - pressure + tick
`), /generator pressure_ramp delta_eq references unknown variable rumor_heat/);
  });

  it("accepts duration literals in expressions", () => {
    const result = parse(`
simfile_version: "0.1"
name: duration-world
clock:
  seed: duration
  tick: 1m
variables:
  moon_fullness:
    scope: global
    range: 0..1
generators:
  moon_cycle:
    kind: deterministic
    variable: moon_fullness
    set_eq: 0.5 + 0.5 * sin(2 * pi * t / 29d)
`);
    assert.equal(result.simfile.generators.moon_cycle.kind, "deterministic");
  });
});
