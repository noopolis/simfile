import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { deriveMembranes, readRunMembranes } from "./membranes.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const JUNGIAN_GOLDEN_DIR = path.resolve(here, "..", "..", "fixtures", "observe", "jungian-daimon-org-golden");
const OFFICE_GOLDEN_DIR = path.resolve(here, "..", "..", "fixtures", "observe", "office-sim-golden");

/**
 * A minimal compile report shaped exactly like `spawnfile compile`'s
 * `spawnfile-report.json` for a recursive self-team org: a root floor network
 * whose room members are the team representatives, plus one inner-council
 * network per self-team. Only the fields `deriveMembranes` reads are present.
 */
const jungianReport = {
  nodes: [
    { kind: "team", id: "team:jungian-daimon-org" },
    { kind: "team", id: "team:luna" },
    { kind: "team", id: "team:selene" },
    {
      kind: "agent",
      id: "agent:luna-representative",
      active_environments: {
        moltnet: {
          "psyche-floor": { rooms: { commons: { member_slot: "luna", team_id: "jungian-daimon-org--luna" } } },
          luna_inner: { rooms: { "luna-council": { member_slot: "luna-representative", team_id: "luna" } } }
        }
      }
    },
    {
      kind: "agent",
      id: "agent:luna-animus",
      active_environments: { moltnet: { luna_inner: { rooms: { "luna-council": { member_slot: "luna-animus", team_id: "luna" } } } } }
    },
    {
      kind: "agent",
      id: "agent:selene-representative",
      active_environments: {
        moltnet: {
          "psyche-floor": { rooms: { commons: { member_slot: "selene", team_id: "jungian-daimon-org--selene" } } },
          selene_inner: { rooms: { "selene-council": { member_slot: "selene-representative", team_id: "selene" } } }
        }
      }
    }
  ],
  container: {
    moltnet: {
      server_plans: [
        {
          id: "jungian-daimon-org-psyche-floor",
          network_id: "psyche-floor",
          mode: "managed",
          rooms: [{ id: "commons", members: ["luna-representative", "selene-representative"] }]
        },
        {
          id: "luna-luna_inner",
          network_id: "luna_inner",
          mode: "managed",
          rooms: [{ id: "luna-council", members: ["luna-animus", "luna-representative", "luna-shadow"] }]
        },
        {
          id: "selene-selene_inner",
          network_id: "selene_inner",
          mode: "managed",
          rooms: [{ id: "selene-council", members: ["selene-animus", "selene-representative", "selene-shadow"] }]
        }
      ]
    }
  }
};

describe("deriveMembranes — from a recursive self-team compile report", () => {
  it("derives one membrane per interior self-team, excluding the root floor team", () => {
    const membranes = deriveMembranes(jungianReport);
    assert.deepEqual(
      membranes.map((m) => m.ref),
      ["team:luna", "team:selene"]
    );
    // The root org team owns the floor network but represents no team on an
    // outer room, so it is never a membrane.
    assert.ok(!membranes.some((m) => m.ref === "team:jungian-daimon-org"));
  });

  it("resolves the representative, interior room, and members for a self-team", () => {
    const luna = deriveMembranes(jungianReport).find((m) => m.ref === "team:luna");
    assert.ok(luna);
    assert.equal(luna!.label, "luna");
    assert.equal(luna!.representative, "agent:luna-representative");
    assert.deepEqual(luna!.interiorRooms, ["room:luna_inner:luna-council"]);
    assert.deepEqual(luna!.members, ["agent:luna-animus", "agent:luna-representative", "agent:luna-shadow"]);
  });

  it("uses member_slot (the represented TEAM), not the agent id, to pick the representative", () => {
    // luna-animus is a luna member but its only member_slot is its own id, so
    // it must never be mistaken for the team's representative.
    const luna = deriveMembranes(jungianReport).find((m) => m.ref === "team:luna");
    assert.notEqual(luna!.representative, "agent:luna-animus");
  });

  it("is deterministic and sorted by ref", () => {
    const first = deriveMembranes(jungianReport).map((m) => m.ref);
    const second = deriveMembranes(jungianReport).map((m) => m.ref);
    assert.deepEqual(first, second);
    assert.deepEqual(first, [...first].sort());
  });
});

describe("deriveMembranes — degenerate inputs", () => {
  it("returns [] for a report with no team nodes", () => {
    assert.deepEqual(deriveMembranes({ nodes: [{ kind: "agent", id: "agent:solo" }], container: { moltnet: { server_plans: [] } } }), []);
  });

  it("returns [] for a non-object report", () => {
    assert.deepEqual(deriveMembranes(null), []);
    assert.deepEqual(deriveMembranes("nope"), []);
    assert.deepEqual(deriveMembranes(undefined), []);
  });

  it("returns [] when a team has a representative slot but owns no server plan", () => {
    const report = {
      nodes: [
        { kind: "team", id: "team:ghost" },
        {
          kind: "agent",
          id: "agent:ghost-rep",
          active_environments: { moltnet: { floor: { rooms: { hall: { member_slot: "ghost" } } } } }
        }
      ],
      container: { moltnet: { server_plans: [{ id: "floor-hall", network_id: "floor", mode: "managed", rooms: [] }] } }
    };
    assert.deepEqual(deriveMembranes(report), []);
  });
});

describe("readRunMembranes — from a run directory", () => {
  it("derives both self-team membranes from the jungian golden run's spawnfile-report.json", async () => {
    const membranes = await readRunMembranes(JUNGIAN_GOLDEN_DIR);
    assert.deepEqual(
      membranes.map((m) => m.ref),
      ["team:luna", "team:selene"]
    );
    const luna = membranes.find((m) => m.ref === "team:luna");
    assert.equal(luna!.representative, "agent:luna-representative");
    assert.deepEqual(luna!.interiorRooms, ["room:luna_inner:luna-council"]);
  });

  it("returns [] for a single-team run with no spawnfile-report.json (office-sim golden)", async () => {
    assert.deepEqual(await readRunMembranes(OFFICE_GOLDEN_DIR), []);
  });
});
