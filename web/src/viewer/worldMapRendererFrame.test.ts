import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildWorldMapRendererFrame } from "./worldMapRendererFrame.js";

describe("world map renderer frame", () => {
  it("builds the shared extension contract without transforming replay data", () => {
    const nodes = [{ id: "object", kind: "marker", scope: "scope", value: "value" }];
    const spatialSamples = [{
      occupancy: {},
      objects: [{ id: "object", position: [1, 2] as [number, number] }],
      tick: 7,
      transit: [],
    }];
    const onSelect = () => {};
    const frame = buildWorldMapRendererFrame({
      nodes: nodes as never[], onSelect, selectedNodeId: "object",
      spatialSamples, tick: 7, tickDurationMs: 25,
    });
    assert.equal(frame.nodes, nodes);
    assert.equal(frame.spatialSamples, spatialSamples);
    assert.equal(frame.onSelect, onSelect);
    assert.equal(frame.selectedNodeId, "object");
    assert.equal(frame.tick, 7);
    assert.equal(frame.tickDurationMs, 25);
  });
});
