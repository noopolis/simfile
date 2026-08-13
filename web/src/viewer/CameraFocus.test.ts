import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cameraFocusForNode } from "./CameraFocus.js";
import { defaultRenderSettings } from "./renderSettings.js";
import type { RoomGeometry, ViewerNode } from "./types.js";
import { viewerSkins } from "./worldModel.js";

const roomNode: ViewerNode = {
  camera: [0.5, 0.5],
  colorRole: "room",
  detail: "field",
  id: "field",
  kind: "room",
  label: "field",
  scale: [24, 12, 0.3],
  scene: [0, 0, 0],
  scope: "world://field",
  subtitle: "square",
  value: "square",
  x: 0,
  y: 0,
};

describe("camera focus", () => {
  it("zooms out enough to frame a large declared world room", () => {
    const room: RoomGeometry = {
      access: ["red", "blue"],
      center: [0, 0, 0],
      doorCutters: { east: [], north: [], south: [], west: [] },
      id: "field",
      node: roomNode,
      size: [24, 12],
      wallHeight: 0.3,
    };
    const skin = viewerSkins[0]!;
    const focus = cameraFocusForNode(roomNode, defaultRenderSettings, skin, [room]);
    assert.ok(focus.zoom < skin.camera.zoom);
    assert.deepEqual(focus.target.slice(0, 2), [0, 0]);
    assert.ok(Math.abs(focus.target[2] - 0.1242) < 1e-9);
  });
});
