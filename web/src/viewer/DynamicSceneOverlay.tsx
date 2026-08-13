import { useGlyphCamera, useGlyphSceneContext } from "@glyphcss/react";
import { memo, useEffect, useLayoutEffect, useRef } from "react";

import type { Vec3 } from "./sceneMotion.js";

export interface DynamicSceneEntity {
  at: Vec3;
  id: string;
  kind: "agent" | "signal";
  label: string;
  selected: boolean;
}

interface ProjectedPoint {
  hidden: boolean;
  left: number;
  top: number;
  zIndex: number;
}

/**
 * Spatial entities move in a tiny DOM overlay. The expensive GlyphCSS pitch
 * remains an immutable background instead of being rasterized on every tick.
 */
export const DynamicSceneOverlay = memo(function DynamicSceneOverlay({
  entities,
  onSelect,
}: {
  entities: DynamicSceneEntity[];
  onSelect: (id: string) => void;
}) {
  const { cameraRef } = useGlyphCamera();
  const { sceneRef } = useGlyphSceneContext();
  const entitiesRef = useRef(entities);
  const elementsRef = useRef(new Map<string, HTMLButtonElement>());
  const signaturesRef = useRef(new Map<string, string>());
  entitiesRef.current = entities;

  const syncProjection = () => {
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (!scene || !camera) return;
    let commits = 0;
    for (const entity of entitiesRef.current) {
      const element = elementsRef.current.get(entity.id);
      if (!element) continue;
      const projection = projectPoint(entity.at, scene, camera);
      const signature = projection.hidden
        ? "hidden"
        : `${projection.left.toFixed(2)}:${projection.top.toFixed(2)}:${projection.zIndex}`;
      if (signaturesRef.current.get(entity.id) === signature) continue;
      signaturesRef.current.set(entity.id, signature);
      element.hidden = projection.hidden;
      if (!projection.hidden) {
        element.style.transform =
          `translate3d(${projection.left.toFixed(2)}px, ${projection.top.toFixed(2)}px, 0) translate(-50%, -50%)`;
        element.style.zIndex = String(projection.zIndex);
      }
      commits += 1;
    }
    if (commits > 0) recordDynamicPositionCommit(commits);
  };

  useLayoutEffect(syncProjection);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      syncProjection();
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [cameraRef, sceneRef]);

  return (
    <div className="dynamic-scene-layer" aria-label="Moving world objects">
      {entities.map((entity) => (
        <button
          aria-label={`Select ${entity.label}`}
          className={`dynamic-scene-entity ${entity.kind} entity-${cssToken(entity.id)} ${entity.selected ? "selected" : ""}`}
          key={entity.id}
          onClick={() => onSelect(entity.id)}
          ref={(element) => {
            if (element) {
              elementsRef.current.set(entity.id, element);
            } else {
              elementsRef.current.delete(entity.id);
              signaturesRef.current.delete(entity.id);
            }
          }}
          type="button"
        >
          <i aria-hidden="true" />
          <span>{entity.label}</span>
        </button>
      ))}
    </div>
  );
});

function projectPoint(
  at: Vec3,
  scene: NonNullable<ReturnType<typeof useGlyphSceneContext>["sceneRef"]["current"]>,
  camera: NonNullable<ReturnType<typeof useGlyphCamera>["cameraRef"]["current"]>,
): ProjectedPoint {
  const options = scene.getOptions();
  const outputRect = scene.output.getBoundingClientRect();
  const hostRect = scene.host.getBoundingClientRect();
  const cols = options.cols ?? 80;
  const rows = options.rows ?? 24;
  const cellAspect = options.cellAspect ?? 2;
  const cellWidth = outputRect.width > 0 ? outputRect.width / cols : 8;
  const cellHeight = outputRect.height > 0 ? outputRect.height / rows : 16;
  const [col, row, depth] = camera.project(
    at,
    cols,
    rows,
    cellAspect,
    { cellWidth, cellHeight },
  );
  return {
    hidden: !Number.isFinite(col) || !Number.isFinite(row)
      || col < -10 || col > cols + 10 || row < -10 || row > rows + 10,
    left: outputRect.left - hostRect.left + (col + 0.5) * cellWidth,
    top: outputRect.top - hostRect.top + (row + 0.5) * cellHeight,
    zIndex: Number.isFinite(depth) ? Math.max(3, Math.round(200_000 + depth)) : 3,
  };
}

function recordDynamicPositionCommit(commits: number): void {
  const target = globalThis as typeof globalThis & {
    __SIMFILE_PLAYBACK_DIAGNOSTICS__?: {
      positionCommits?: number;
      positionFrames?: number;
    };
  };
  if (target.__SIMFILE_PLAYBACK_DIAGNOSTICS__) {
    target.__SIMFILE_PLAYBACK_DIAGNOSTICS__.positionCommits =
      (target.__SIMFILE_PLAYBACK_DIAGNOSTICS__.positionCommits ?? 0) + commits;
    target.__SIMFILE_PLAYBACK_DIAGNOSTICS__.positionFrames =
      (target.__SIMFILE_PLAYBACK_DIAGNOSTICS__.positionFrames ?? 0) + 1;
  }
}

function cssToken(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/gu, "-");
}
