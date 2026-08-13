import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildTileWorld } from "./tileWorld.js";
import type { ViewerNode } from "./types.js";

describe("buildTileWorld transit layer", () => {
  it("renders a moving agent as a directional, visibly distinct transit glyph", () => {
    const agent: ViewerNode = {
      camera: [0.5, 0.5],
      colorRole: "agent",
      detail: "commuting",
      id: "eleanor",
      in_transit: true,
      kind: "agent",
      label: "eleanor",
      scene: [0, 0, 0.055],
      scope: "agent:eleanor",
      scale: 0.18,
      subtitle: "in transit",
      transit_heading: Math.PI,
      value: "in transit",
      x: 0,
      y: 0
    };

    const world = buildTileWorld({ nodes: [agent], roomPaths: [], rooms: [], roomScale: 1, terrainMix: 1 });
    const cell = world.layers.find((layer) => layer.id === "agents")?.cells[0];
    assert.equal(cell?.glyph, "<");
    assert.equal(cell?.tone, "transit");
  });
});
