import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseGltf, recenterPolygons } from "@glyphcss/core";

import {
  avatarTransforms,
  tintAvatarModel,
} from "./avatarModel.js";
import { defaultRenderSettings } from "./renderSettings.js";
import type { AgentPlacement } from "./sceneMotion.js";

describe("GlyphCSS Man avatar", () => {
  it("ships the exact attributed gallery asset at realistic human height", async () => {
    const path = fileURLToPath(new URL("../../public/models/man.glb", import.meta.url));
    const bytes = await readFile(path);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      "dad8fa3ca2bc7760892f9ff47f544941179e50acb2aa772cf9f035154a37fc58",
    );
    const polygons = recenterPolygons(parseGltf(bytes).polygons);
    const z = polygons.flatMap((polygon) => polygon.vertices.map((vertex) => vertex[2]));
    const sourceHeight = Math.max(...z) - Math.min(...z);
    const placement: AgentPlacement = {
      animation: { clip: "run", phase: 0, timeScale: 1 },
      heading: 0,
      labelPosition: [0, 0, 0],
      moving: true,
      nextRoomId: "atrium",
      node: {
        camera: [0.5, 0.5],
        colorRole: "agent",
        detail: "",
        id: "walker",
        kind: "agent",
        label: "walker",
        scale: 1,
        scene: [0, 0, 0],
        scope: "agent:walker",
        subtitle: "",
        value: "",
        x: 0,
        y: 0,
      },
      position: [0, 0, 0.055],
      roomId: "atrium",
      speedMps: 5.5,
      stride: 0,
    };
    const transforms = avatarTransforms(
      placement,
      { ...defaultRenderSettings, agentScale: 1 },
    );
    assert.ok(Math.abs(sourceHeight * transforms.model.scale - 1.75) < 1e-6);
    assert.ok(tintAvatarModel(polygons, "#7c5cff").every((polygon) =>
      polygon.color === "#7c5cff"));
  });
});
