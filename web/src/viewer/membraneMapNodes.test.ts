import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { membraneMapNodes } from "./membraneMapNodes.js";
import type { RunTimelineMembrane } from "../store/timeline.js";
import type { ViewerNode } from "./types.js";

const representativeNode: ViewerNode = {
  id: "luna-representative",
  label: "luna-representative",
  kind: "agent",
  scope: "agent:luna-representative",
  subtitle: "heuristic",
  detail: "",
  value: "heuristic",
  x: 0,
  y: 0,
  camera: [0.5, 0.5],
  scene: [1, 2, 0.05],
  scale: 0.18,
  colorRole: "agent",
};

const membrane: RunTimelineMembrane = {
  ref: "team:luna",
  label: "luna",
  representative: "agent:luna-representative",
  interiorRooms: ["room:luna_inner:luna-council"],
  members: ["agent:luna-animus", "agent:luna-representative", "agent:luna-shadow"],
};

describe("membraneMapNodes", () => {
  it("synthesizes a team node beside its representative's own position", () => {
    const [node] = membraneMapNodes([representativeNode], [membrane]);
    assert.equal(node?.kind, "team");
    assert.equal(node?.scope, "team:luna");
    assert.equal(node?.id, "team:luna");
    assert.equal(node?.label, "luna");
    assert.notDeepEqual(node?.scene, representativeNode.scene);
    assert.equal(node?.scene[2], representativeNode.scene[2]);
  });

  it("skips a membrane whose representative has no rendered node yet", () => {
    const nodes = membraneMapNodes([], [membrane]);
    assert.deepEqual(nodes, []);
  });

  it("returns one node per membrane, in membrane order", () => {
    const selene: RunTimelineMembrane = { ...membrane, ref: "team:selene", label: "selene", representative: "agent:luna-representative" };
    const nodes = membraneMapNodes([representativeNode], [membrane, selene]);
    assert.deepEqual(nodes.map((node) => node.scope), ["team:luna", "team:selene"]);
  });
});
