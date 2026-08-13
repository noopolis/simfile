import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseSimfileSource } from "./parse.js";

const officeWorldSource = `
simfile_version: "0.1"
name: office-world
spawnfile: ./Spawnfile
clock:
  seed: office-test
  tick: 20s
  sim_per_tick: 10m
  phases:
    morning: "07:00"
    workday: "09:00"
    evening: "18:00"
    night: "22:00"
variables:
  filing_pressure:
    scope: room:office-floor:case-warroom
    initial: 0.4
    range: 0..1
  hall_heat:
    scope: room:office-floor:office-hall
    range: 0..40
    measure:
      kind: messages_in
      window: 30m
  evening_pull:
    scope: global
    initial: 0.1
    range: 0..1
  social_weather:
    scope: global
    range: 0..1
    derive:
      eq: 0.015 * hall_heat + 0.6 * evening_pull
generators:
  deadline_ramp:
    kind: deterministic
    when:
      phase: workday
    variable: filing_pressure
    delta: 0.02
  day_texture:
    kind: stochastic
    variable: evening_pull
    uniform: [-0.01, 0.03]
  filing_pressure_relax:
    kind: deterministic
    variable: filing_pressure
    delta_eq: clamp(0.4 - filing_pressure, -0.01, 0.01)
rules:
  maribel_calls:
    fire: once
    when:
      phase: workday
    do:
      - action: moltnet:message
        to: room:office-floor:office-hall
        content: "Maribel calls: she found the contractor texts."
  witness_revealed:
    fire: once
    when:
      all:
        - event: rule.fired
          actor: maribel_calls
        - phase: workday
    do:
      - action: moltnet:message
        to: room:office-floor:case-warroom
        content: "The witness is Rosa Delgado."
  deadline_bites:
    when:
      variable: filing_pressure
      above: 0.85
    do:
      - action: moltnet:message
        to: room:office-floor:case-warroom
        content: "Observation notice."
  hall_goes_quiet:
    when:
      all:
        - variable: filing_pressure
          above: 0.85
        - variable: hall_heat
          below: 3
          for: 30m
    do:
      - action: moltnet:message
        to: room:office-floor:office-hall
        content: "The office has gone quiet with the deadline at {filing_pressure}."
ledger:
  store:
    kind: sqlite
    path: .sim/ledger.db
telemetry:
  snapshot_every: 50
markers:
  tenant_name:
    text:
      - "Rosa Delgado"
      - "Ms. Delgado"
    mode: containment
    scopes:
      - room:office-floor:case-warroom
      - team:office
  crunch_phrase:
    text:
      - "gone quiet with the deadline"
    mode: propagation
    scopes:
      - room:office-floor:office-hall
      - room:office-floor:break-room
probes:
  deadline_observed:
    when:
      event: world.message
      target: room:office-floor:case-warroom
    expect:
      at_least: 1
`;

describe("parseSimfileSource", () => {
  it("parses a valid YAML Simfile", () => {
    const result = parseSimfileSource(officeWorldSource, { path: "Simfile.yaml" });

    assert.equal(result.simfile.name, "office-world");
    assert.equal(result.simfile.clock.phases.workday, "09:00");
    assert.equal(result.simfile.variables.filing_pressure.scope, "room:office-floor:case-warroom");
    assert.equal(result.simfile.generators.day_texture.kind, "stochastic");
    assert.equal(result.simfile.ledger?.store.kind, "sqlite");
    assert.deepEqual(result.warnings, []);
  });

  it("validates identifier, duration, and scope constraints", () => {
    assert.throws(() => parseSimfileSource(`
simfile_version: "0.1"
name: "Office-World"
clock:
  seed: bad-duration
  tick: 1jiffy
  phases:
    day: "08:00"
`, { path: "Simfile.yaml" }), /expected lowercase identifier|expected duration string/);

    assert.throws(() => parseSimfileSource(`
simfile_version: "0.1"
name: office-world
clock:
  seed: bad-scope
  tick: 1m
  phases:
    day: "08:00"
variables:
  filing_pressure:
    scope: room:office floor:case
    range: 1..0
`, { path: "Simfile.yaml" }), /expected room scope|lower bound/);
  });

  it("validates generators and rule actions to supported kinds", () => {
    assert.throws(() => parseSimfileSource(`
simfile_version: "0.1"
name: tiny-world
clock:
  seed: bad-generator
  tick: 1m
  phases:
    day: "08:00"
generators:
  bad_gen:
    kind: random
    variable: filing_pressure
    uniform: [-1, 1]
    `, { path: "Simfile.yaml" }), /expected "deterministic"|"stochastic"/);

    assert.throws(() => parseSimfileSource(`
simfile_version: "0.1"
name: tiny-world
clock:
  seed: bad-action
  tick: 1m
  phases:
    day: "08:00"
variables:
  filing_pressure:
    scope: global
    range: 0..1
rules:
  ping:
    when:
      phase: day
    do:
      - action: moltnet:message
        to: agent:eleanor
        content: "bad scope for room action"
`, { path: "Simfile.yaml" }), /expected room scope/);

    assert.throws(() => parseSimfileSource(`
simfile_version: "0.1"
name: tiny-world
clock:
  seed: bad-variable-action
  tick: 1m
  phases:
    day: "08:00"
variables:
  filing_pressure:
    scope: global
    range: 0..1
rules:
  ping:
    when:
      phase: day
    do:
      - action: variable:set
        variable: filing_pressure
`, { path: "Simfile.yaml" }), /Expected object|content|value/);
  });

  it("rejects unsupported event names in conditions", () => {
    assert.throws(() => parseSimfileSource(`
simfile_version: "0.1"
name: tiny-world
clock:
  seed: bad-event
  tick: 1m
rules:
  ping:
    when:
      event: user.clicked
    do:
      - action: moltnet:message
        to: room:office-floor:case-warroom
        content: "Observation notice."
`, { path: "Simfile.yaml" }), /clock\.sync|wake\.recommended|marker\.seen/);
  });

  it("requires probe after and within to be declared together", () => {
    assert.throws(() => parseSimfileSource(`
simfile_version: "0.1"
name: missing-within-world
clock:
  seed: probe-window
  tick: 1m
probes:
  bad_window:
    when:
      event: world.message
    after:
      event: world.message
    expect:
      at_least: 1
`, { path: "Simfile.yaml" }), /after requires within/);

    assert.throws(() => parseSimfileSource(`
simfile_version: "0.1"
name: missing-after-world
clock:
  seed: probe-window
  tick: 1m
probes:
  bad_window:
    when:
      event: world.message
    within: 10m
    expect:
      at_least: 1
`, { path: "Simfile.yaml" }), /within requires after/);
  });

  it("accepts minimal world with clock only", () => {
    const result = parseSimfileSource(`
simfile_version: "0.1"
name: tiny-world
clock:
  seed: minimal
  tick: 1m
`, { path: "Simfile.yaml" });

    assert.equal(result.simfile.name, "tiny-world");
    assert.equal(result.simfile.clock.tick, "1m");
    assert.deepEqual(result.simfile.clock.phases, {});
    assert.deepEqual(result.warnings, []);
  });

  it("rejects obsolete schema keys", () => {
    assert.throws(() => parseSimfileSource(`
simfile_version: "0.1"
kind: simulation
name: legacy-world
clock:
  seed: legacy
  tick: 1m
  phases:
    day: "08:00"
actors:
  - id: eleanor
    agent: eleanor
`), /"kind"[\s\S]*"actors"/u);
  });
});
