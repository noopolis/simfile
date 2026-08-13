import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseSimfileSource } from "./parse.js";

describe("places and initial presence", () => {
  it("parses declared places and opaque agent ids", () => {
    const result = parseSimfileSource(`
simfile_version: "0.1"
name: presence-world
clock:
  seed: presence
  tick: 1m
places:
  atrium:
    label: Shared Atrium
  plaza:
    kind: square
presence:
  "agent:Alpha/1": atrium
  beta: plaza
`, { path: "Simfile.yaml" });

    assert.deepEqual(result.simfile.places, {
      atrium: { label: "Shared Atrium", kind: "room" },
      plaza: { kind: "square" }
    });
    assert.deepEqual(result.simfile.presence, {
      "agent:Alpha/1": "atrium",
      beta: "plaza"
    });
    assert.deepEqual(result.warnings, []);
  });

  it("parses routes and move actions with bidirectional routes by default", () => {
    const result = parseSimfileSource(`
simfile_version: "0.1"
name: movement-world
clock:
  seed: movement
  tick: 1m
places:
  atrium: {}
  plaza: {}
routes:
  arcade:
    from: atrium
    to: plaza
    travel_ticks: 3
presence:
  alpha: atrium
rules:
  cross-arcade:
    fire: once
    when:
      event: clock.sync
    do:
      - action: move
        agent: alpha
        to: plaza
`, { path: "Simfile.yaml" });

    assert.deepEqual(result.simfile.routes.arcade, {
      from: "atrium",
      to: "plaza",
      travel_ticks: 3,
      direction: "bidirectional"
    });
    assert.deepEqual(result.simfile.rules["cross-arcade"]?.do, [
      { action: "move", agent: "alpha", to: "plaza" }
    ]);
    assert.deepEqual(result.warnings, []);
  });

  it("warns when initial presence references an unknown place", () => {
    const result = parseSimfileSource(`
simfile_version: "0.1"
name: unknown-place-world
clock:
  seed: presence
  tick: 1m
places:
  atrium: {}
presence:
  alpha: missing-place
`, { path: "Simfile.yaml" });

    assert.deepEqual(result.warnings, [
      'presence "alpha" references unknown place missing-place'
    ]);
  });

  it("warns for invalid route endpoints and unbound move actions", () => {
    const result = parseSimfileSource(`
simfile_version: "0.1"
name: invalid-movement-world
clock:
  seed: movement
  tick: 1m
places:
  atrium: {}
  plaza: {}
  isolated: {}
routes:
  broken:
    from: missing-from
    to: missing-to
    travel_ticks: 1
  arcade:
    from: atrium
    to: plaza
    travel_ticks: 2
presence:
  alpha: atrium
rules:
  no-route:
    when: { event: clock.sync }
    do:
      - { action: move, agent: alpha, to: isolated }
  unknown-agent:
    when: { event: clock.sync }
    do:
      - { action: move, agent: ghost, to: plaza }
  unknown-place:
    when: { event: clock.sync }
    do:
      - { action: move, agent: alpha, to: nowhere }
`, { path: "Simfile.yaml" });

    assert.deepEqual(result.warnings, [
      'route "broken" from references unknown place missing-from',
      'route "broken" to references unknown place missing-to',
      'rule "no-route" action move has no route from atrium to isolated',
      'rule "unknown-agent" action move references unknown agent ghost',
      'rule "unknown-place" action move references unknown place nowhere'
    ]);
  });
});
