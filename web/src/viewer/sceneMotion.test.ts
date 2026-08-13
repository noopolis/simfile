import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAgentPlacements } from "./sceneMotion.js";
import type { RoomGeometry, RoomPath, ViewerNode, ViewerPresenceEvent } from "./types.js";

const room = (id: string, x: number): RoomGeometry => ({
  access: ["eleanor", "sam"],
  center: [x, 0, 0],
  doorCutters: { north: [], south: [], east: [], west: [] },
  id,
  node: {
    camera: [0.5, 0.5], colorRole: "room", detail: "", id, kind: "room", label: id,
    scene: [x, 0, 0], scope: id, scale: [1, 1, 0.3], subtitle: "", value: "room", x: 0, y: 0
  },
  size: [1.4, 0.9],
  wallHeight: 0.3
});

const office = room("room:commute:office", 0);
const home = room("room:commute:home", 3);
const path: RoomPath = {
  from: office,
  id: "office_home",
  path: [[0, 0, 0.055], [3, 0, 0.055]],
  to: home,
  width: 0.08
};
const agent: ViewerNode = {
  camera: [0.5, 0.5], colorRole: "agent", detail: "", id: "eleanor", kind: "agent", label: "eleanor",
  scene: [0, 0, 0], scope: "agent:eleanor", scale: 0.18, subtitle: "presence-driven", value: office.id, x: 0, y: 0
};
const presence: ViewerPresenceEvent[] = [
  { actor: "eleanor", room: office.id, tick: 0, type: "presence.arrived" },
  { actor: "eleanor", from_room: office.id, path_id: path.id, tick: 7, to_room: home.id, type: "presence.departed" },
  {
    actor: "eleanor", arrived_at: 9, from_room: office.id, path_id: path.id,
    started_at: 7, tick: 7, to_room: home.id, type: "presence.in_transit"
  },
  { actor: "eleanor", room: home.id, tick: 9, type: "presence.arrived" }
];

describe("createAgentPlacements", () => {
  it("shows departure and intermediate ticks in transit, then occupies the destination on arrival", () => {
    const at = (tick: number) => createAgentPlacements({
      nodes: [agent], paths: [path], presenceByAgent: { eleanor: presence }, rooms: [office, home], tick
    })[0]!;

    assert.equal(at(7).moving, true);
    assert.equal(at(8).moving, true);
    assert.ok(at(8).position[0] > 0 && at(8).position[0] < 3);
    assert.equal(at(9).moving, false);
    assert.equal(at(9).roomId, home.id);
  });
});
