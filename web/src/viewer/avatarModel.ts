import { useEffect, useState } from "react";
import { loadMesh, recenterPolygons } from "@glyphcss/core";
import type { Polygon } from "@glyphcss/core";

const avatarModelSrc = "/models/AnimatedMushnub.glb";

let cachedModel: Polygon[] | null = null;
let pendingModel: Promise<Polygon[]> | null = null;

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
