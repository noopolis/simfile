import { useGlyphCamera } from "@glyphcss/react";
import { useLayoutEffect, useRef } from "react";

import type { RenderSettings } from "./renderSettings.js";
import type { Vec3 } from "./sceneMotion.js";
import type { RoomGeometry, ViewerNode } from "./types.js";
import type { ViewerSkin } from "./worldModel.js";

interface CameraFocusTarget {
  center: [number, number];
  target: Vec3;
  zoom: number;
}

interface CameraFocusProps {
  focus: CameraFocusTarget;
}

export function CameraFocus({ focus }: CameraFocusProps) {
  const { cameraRef, rerender } = useGlyphCamera();
  const frameRef = useRef<number | null>(null);
  const lastAppliedRef = useRef<CameraFocusTarget | null>(null);

  useLayoutEffect(() => {
    const camera = cameraRef.current;
    if (!camera) {
      return;
    }

    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }

    const previous = lastAppliedRef.current;
    const startTarget = previous ? [...previous.target] as Vec3 : [...camera.target] as Vec3;
    const endTarget = [...focus.target] as Vec3;
    const startCenter = previous ? [...previous.center] as [number, number] : [...camera.center] as [number, number];
    const endCenter = [...focus.center] as [number, number];
    const startZoom = previous?.zoom ?? camera.zoom;
    const endZoom = focus.zoom;
    if (sameFocus(startTarget, endTarget, startCenter, endCenter, startZoom, endZoom)) {
      return;
    }
    const durationMs = 720;
    let progress = 0;
    let lastFrameAt = performance.now();

    const applyFrame = (amount: number) => {
      const eased = easeInOutCubic(amount);
      camera.center = lerpVec2(startCenter, endCenter, eased);
      camera.target = lerpVec3(startTarget, endTarget, eased);
      camera.zoom = lerp(startZoom, endZoom, eased);
      lastAppliedRef.current = {
        center: [...camera.center],
        target: [...camera.target] as Vec3,
        zoom: camera.zoom,
      };
      rerender();
    };

    applyFrame(0);

    const step = (now: number) => {
      const delta = Math.min(34, Math.max(0, now - lastFrameAt));
      lastFrameAt = now;
      progress = Math.min(1, progress + delta / durationMs);
      applyFrame(progress);
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(step);
        return;
      }

      frameRef.current = null;
    };

    frameRef.current = requestAnimationFrame(step);

    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [cameraRef, focus, rerender]);

  return null;
}

export function cameraFocusForNode(
  node: ViewerNode,
  renderSettings: RenderSettings,
  skin: ViewerSkin,
  rooms: RoomGeometry[],
): CameraFocusTarget {
  const room = node.kind === "room" ? rooms.find((candidate) => candidate.node.id === node.id) : undefined;
  if (!room) {
    return {
      center: [0.5, 0.5],
      target: [node.scene[0], node.scene[1], node.scene[2]],
      zoom: skin.camera.zoom * 1.45,
    };
  }

  const longestSide = Math.max(room.size[0], room.size[1]) * renderSettings.roomScale;
  const focusMultiplier = clamp(5.8 / Math.max(1, longestSide), 1.35, 2.25);
  return {
    center: [0.5, 0.5],
    target: [room.center[0], room.center[1], Math.max(0.08, room.wallHeight * renderSettings.wallHeightScale * 0.45)],
    zoom: skin.camera.zoom * focusMultiplier,
  };
}

function easeInOutCubic(value: number): number {
  return value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function lerpVec2(a: [number, number], b: [number, number], t: number): [number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
}

function sameFocus(
  startTarget: Vec3,
  endTarget: Vec3,
  startCenter: [number, number],
  endCenter: [number, number],
  startZoom: number,
  endZoom: number,
): boolean {
  return Math.abs(startZoom - endZoom) < 0.01
    && Math.abs(startTarget[0] - endTarget[0]) < 0.001
    && Math.abs(startTarget[1] - endTarget[1]) < 0.001
    && Math.abs(startTarget[2] - endTarget[2]) < 0.001
    && Math.abs(startCenter[0] - endCenter[0]) < 0.001
    && Math.abs(startCenter[1] - endCenter[1]) < 0.001;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
