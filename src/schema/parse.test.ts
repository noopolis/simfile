import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseSimfileSource } from "./parse.js";

const validSource = `
simfile_version: "0.1"
kind: simulation
name: office-world
clock:
  tick: 20s
  phases:
    - id: morning
      starts: "07:00"
actors:
  - id: eleanor
    agent: eleanor
    needs:
      rest: 0.4
locations:
  - id: office-hall
    room: office-floor:office-hall
    pressures:
      deadline: 0.8
actions:
  - id: file_response
salience:
  wake_when:
    - pressure: deadline
      above: 0.7
ledger:
  events:
    - case.progressed
`;

describe("parseSimfileSource", () => {
  it("parses a valid YAML Simfile", () => {
    const result = parseSimfileSource(validSource, { path: "Simfile.yaml" });

    assert.equal(result.simfile.name, "office-world");
    assert.equal(result.simfile.clock.phases[0]?.id, "morning");
    assert.equal(result.simfile.actors[0]?.needs?.rest, 0.4);
    assert.deepEqual(result.warnings, []);
  });

  it("reports missing optional world sections as warnings", () => {
    const result = parseSimfileSource(`
simfile_version: "0.1"
kind: simulation
name: empty-world
clock:
  tick: 1m
  phases:
    - id: day
      starts: "08:00"
`);

    assert.deepEqual(result.warnings, [
      "simulation has no actors",
      "simulation has no locations"
    ]);
  });

  it("rejects duplicate semantic ids", () => {
    assert.throws(() => parseSimfileSource(`
simfile_version: "0.1"
kind: simulation
name: duplicate-world
clock:
  tick: 1m
  phases:
    - id: day
      starts: "08:00"
actors:
  - id: eleanor
  - id: eleanor
`), /actors contains duplicate ids: eleanor/u);
  });
});
