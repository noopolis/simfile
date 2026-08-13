import { useEffect, useState } from "react";
import { loadMesh, recenterPolygons } from "@glyphcss/core";
import type { Polygon } from "@glyphcss/core";

import type { RenderSettings } from "./renderSettings.js";
import type { AgentPlacement, Vec3 } from "./sceneMotion.js";

const avatarModelSrc = "/models/man.glb";
const avatarSourceFloorOffset = 27.9455;
const avatarSourceHeight = 55.891;
const avatarWorldHeight = 1.75;

let cachedModel: Polygon[] | null = null;
let pendingModel: Promise<Polygon[]> | null = null;
const tintedModels = new WeakMap<Polygon[], Map<string, Polygon[]>>();

export interface AvatarTransforms {
  base: {
    position: Vec3;
    scale: Vec3;
  };
  model: {
    position: Vec3;
    rotation: Vec3;
    scale: number;
  };
}

export function useAvatarModel(): Polygon[] | null {
  const [polygons, setPolygons] = useState(cachedModel);

  useEffect(() => {
    let cancelled = false;
    void loadAvatarModel().then((model) => {
      if (!cancelled) {
        setPolygons(model);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return polygons;
}

function loadAvatarModel(): Promise<Polygon[]> {
  if (cachedModel) {
    return Promise.resolve(cachedModel);
  }
  pendingModel ??= loadMesh(avatarModelSrc)
    .then((result) => {
      cachedModel = recenterPolygons(result.polygons);
      return cachedModel;
    })
    .catch(() => {
      cachedModel = [];
      return cachedModel;
    });
  return pendingModel;
}

export function avatarTransforms(
  placement: AgentPlacement,
  renderSettings: RenderSettings,
): AvatarTransforms {
  const [x, y, z] = placement.position;
  const modelScale = avatarWorldHeight / avatarSourceHeight
    * renderSettings.agentScale;
  const baseScale = 0.55 * renderSettings.agentScale;
  return {
    base: {
      position: [x, y, z + 0.018],
      scale: [baseScale, baseScale, 0.035],
    },
    model: {
      position: [x, y, z + avatarSourceFloorOffset * modelScale],
      rotation: [0, 0, placement.heading - Math.PI / 2],
      scale: modelScale,
    },
  };
}

export function tintAvatarModel(
  polygons: Polygon[],
  color: string,
): Polygon[] {
  let byColor = tintedModels.get(polygons);
  if (!byColor) {
    byColor = new Map();
    tintedModels.set(polygons, byColor);
  }
  const cached = byColor.get(color);
  if (cached) return cached;
  const tinted = polygons.map((polygon) => ({ ...polygon, color }));
  byColor.set(color, tinted);
  return tinted;
}
