import {
  GlyphPerspectiveCamera,
  useGlyphCamera,
  useGlyphSceneContext,
} from "@glyphcss/react";
import type { GlyphCamera, GlyphSceneHandle } from "glyphcss";
import { useEffect, useLayoutEffect, useState } from "react";
import type { ReactNode } from "react";

import type { ViewerNode } from "./types.js";
import type { ViewerSkin } from "./worldModel.js";
import { measureDynamicGlyphRerender } from "./dynamicGlyphTelemetry.js";

export interface GlyphLayerRegistry {
  staticCamera: GlyphCamera | null;
  staticScene: GlyphSceneHandle | null;
}

export const createGlyphLayerRegistry = (): GlyphLayerRegistry => ({
  staticCamera: null,
  staticScene: null,
});

export function SeededPerspectiveCamera({
  children,
  className = "glyph-camera",
  selectedNode,
  selectedSkin,
}: {
  children: ReactNode;
  className?: string;
  selectedNode: ViewerNode;
  selectedSkin: ViewerSkin;
}) {
  const [seeded, setSeeded] = useState(false);
  useEffect(() => setSeeded(true), []);
  return (
    <GlyphPerspectiveCamera
      center={seeded ? undefined : selectedNode.camera}
      className={className}
      distance={seeded ? undefined : selectedSkin.camera.distance}
      rotX={seeded ? undefined : selectedSkin.camera.rotX}
      rotY={seeded ? undefined : selectedSkin.camera.rotY}
      zoom={seeded ? undefined : selectedSkin.camera.zoom}
    >
      {children}
    </GlyphPerspectiveCamera>
  );
}

export function StaticGlyphLayerCapture({
  registry,
}: {
  registry: GlyphLayerRegistry;
}) {
  const { cameraRef } = useGlyphCamera();
  const { sceneRef } = useGlyphSceneContext();
  useLayoutEffect(() => {
    const scene = sceneRef.current;
    registry.staticCamera = cameraRef.current;
    registry.staticScene = scene;
    if (!scene) return undefined;
    const originalRerender = scene.rerender.bind(scene);
    scene.rerender = () => {
      const shared = playbackShared();
      shared.staticGlyphRenders = Number(shared.staticGlyphRenders ?? 0) + 1;
      originalRerender();
    };
    return () => {
      scene.rerender = originalRerender;
      registry.staticCamera = null;
      registry.staticScene = null;
    };
  }, [cameraRef, registry, sceneRef]);
  return null;
}

export function DynamicGlyphCameraSync({
  registry,
  scale,
}: {
  registry: GlyphLayerRegistry;
  scale: number;
}) {
  const { cameraRef } = useGlyphCamera();
  const { sceneRef } = useGlyphSceneContext();

  useEffect(() => {
    let frame = 0;
    const sync = () => {
      const source = registry.staticCamera;
      const target = cameraRef.current;
      const scene = sceneRef.current;
      if (source && target && scene) {
        const changed = copyGlyphCameraState(source, target);
        if (changed) {
          measureDynamicGlyphRerender(() => scene.rerender(), scale);
        }
        recordAlignment(registry.staticScene, source, scene, target);
      }
      frame = requestAnimationFrame(sync);
    };
    frame = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(frame);
  }, [cameraRef, registry, scale, sceneRef]);
  return null;
}

export function copyGlyphCameraState(
  source: GlyphCamera,
  target: GlyphCamera,
): boolean {
  const before = cameraSignature(target);
  target.rotX = source.rotX;
  target.rotY = source.rotY;
  target.center = [...source.center];
  target.mat = source.mat ? [...source.mat] : null;
  target.useMat = source.useMat;
  target.distance = source.distance;
  target.perspective = source.perspective;
  target.zoom = source.zoom;
  target.stretch = source.stretch;
  target.fovScale = source.fovScale;
  target.target = [...source.target];
  target.eyeMode = source.eyeMode;
  return before !== cameraSignature(target);
}

function cameraSignature(camera: GlyphCamera): string {
  return [
    camera.rotX,
    camera.rotY,
    ...camera.center,
    camera.distance,
    camera.perspective,
    camera.zoom,
    camera.stretch,
    camera.fovScale,
    ...camera.target,
    camera.eyeMode ? 1 : 0,
    camera.useMat ? 1 : 0,
    ...(camera.mat ?? []),
  ].join(":");
}

function recordAlignment(
  staticScene: GlyphSceneHandle | null,
  staticCamera: GlyphCamera,
  dynamicScene: GlyphSceneHandle,
  dynamicCamera: GlyphCamera,
): void {
  if (!staticScene) return;
  const staticSignature = numericSignature(staticCamera);
  const dynamicSignature = numericSignature(dynamicCamera);
  const cameraError = staticSignature
    .reduce((maximum, value, index) =>
      Math.max(maximum, Math.abs(value - dynamicSignature[index]!)), 0);
  const points: Array<[number, number, number]> = [
    [0, 0, 0],
    [-10, -6, 0],
    [10, 6, 0],
  ];
  const projectionError = points.reduce((maximum, point) => {
    const left = projectPixel(staticScene, staticCamera, point);
    const right = projectPixel(dynamicScene, dynamicCamera, point);
    return Math.max(maximum, Math.hypot(left[0] - right[0], left[1] - right[1]));
  }, 0);
  const shared = playbackShared();
  shared.cameraAlignmentError = cameraError;
  shared.projectionAlignmentErrorPx = projectionError;
  shared.projectionAlignmentMaxErrorPx = Math.max(
    Number(shared.projectionAlignmentMaxErrorPx ?? 0),
    projectionError,
  );
}

function numericSignature(camera: GlyphCamera): number[] {
  return [
    camera.rotX,
    camera.rotY,
    ...camera.center,
    camera.distance,
    camera.perspective,
    camera.zoom,
    camera.stretch,
    camera.fovScale,
    ...camera.target,
  ];
}

function projectPixel(
  scene: GlyphSceneHandle,
  camera: GlyphCamera,
  point: [number, number, number],
): [number, number] {
  const options = scene.getOptions();
  const rect = scene.output.getBoundingClientRect();
  const cols = options.cols ?? 80;
  const rows = options.rows ?? 24;
  const cellAspect = options.cellAspect ?? 2;
  const cellWidth = rect.width > 0 ? rect.width / cols : 8;
  const cellHeight = rect.height > 0 ? rect.height / rows : 16;
  const [col, row] = camera.project(
    point,
    cols,
    rows,
    cellAspect,
    { cellHeight, cellWidth },
  );
  return [rect.left + (col + 0.5) * cellWidth, rect.top + (row + 0.5) * cellHeight];
}

function playbackShared(): Record<string, number | boolean> {
  const target = globalThis as typeof globalThis & {
    __SIMFILE_PLAYBACK_DIAGNOSTICS__?: Record<string, number | boolean>;
  };
  return target.__SIMFILE_PLAYBACK_DIAGNOSTICS__ ??= {};
}
