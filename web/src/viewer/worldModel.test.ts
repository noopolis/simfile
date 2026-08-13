import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ViewerContractTrace } from "./types.js";
import { buildViewerWorld, trimUnpresentableSpatialPrefix } from "./worldModel.js";

const baseTrace = (): ViewerContractTrace => ({
  version: "viewer.trace.v1",
  run_id: "viewer-world-test",
  run_name: "viewer-world-test",
  rooms: [
    {
      id: "office-hall",
      label: "office-hall",
      members: ["alice"],
      scene: [0, 0, 0],
      scope: "room:office-floor:office-hall"
    }
  ],
  corridors: [],
  agents: [
    {
      detail: "Trace has this agent but no presence stream yet.",
      id: "alice",
      label: "alice",
      label_hint: "heuristic",
      scope: "agent:alice"
    }
  ],
  presence: [],
  ledger_facts: [],
  signals: []
});

describe("buildViewerWorld", () => {
  it("keeps heuristic agents out of room bodies when no presence stream exists", () => {
    const world = buildViewerWorld(baseTrace());
    const alice = world.nodes.find((node) => node.id === "alice");
    assert.equal(alice?.value, "heuristic");
    assert.equal(alice?.subtitle, "heuristic · no presence stream");
  });

  it("lets real presence override a heuristic trace label", () => {
    const trace = baseTrace();
    trace.presence = [
      {
        type: "presence.arrived",
        actor: "alice",
        room: "office-hall",
        tick: 2
      }
    ];

    const world = buildViewerWorld(trace);
    const alice = world.nodes.find((node) => node.id === "alice");
    assert.equal(alice?.value, "office-hall");
    assert.equal(alice?.subtitle, "presence-driven");
  });

  it("starts after a legacy multi-second reset gap without trimming sparse motion", () => {
    const objects = (position: number) => [{
      id: "alice",
      position: [position, 0] as [number, number],
      velocity: [0.1, 0] as [number, number],
    }];
    const legacy = [
      { occupancy: {}, objects: objects(0), tick: 0, transit: [] },
      {
        discontinuities: ["alice"],
        occupancy: {},
        objects: objects(4),
        tick: 460,
        transit: [],
      },
      { occupancy: {}, objects: objects(4.5), tick: 465, transit: [] },
    ];
    assert.deepEqual(
      trimUnpresentableSpatialPrefix(legacy, 20).map((sample) => sample.tick),
      [460, 465],
    );
    assert.equal(
      trimUnpresentableSpatialPrefix([
        legacy[0]!,
        { ...legacy[1]!, tick: 50 },
      ], 20).length,
      2,
    );
  });
});
