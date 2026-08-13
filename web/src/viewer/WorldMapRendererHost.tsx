import { useLayoutEffect, useRef } from "react";

import type {
  WorldMapRendererDefinition,
  WorldMapRendererFrame,
  WorldMapRendererInstance,
  ViewerPrimarySurface,
} from "../../../src/viewer-extension/index.js";

export type {
  WorldMapRendererDefinition,
  WorldMapRendererFrame,
  WorldMapRendererInstance,
  ViewerPrimarySurface,
} from "../../../src/viewer-extension/index.js";

export function WorldMapRendererHost({
  fitRevision,
  frame,
  renderer,
}: {
  fitRevision?: number;
  frame: WorldMapRendererFrame;
  renderer: WorldMapRendererDefinition;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<WorldMapRendererInstance | null>(null);
  const frameRef = useRef(frame);
  frameRef.current = frame;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const instance = renderer.mount(host, frameRef.current);
    instanceRef.current = instance;
    return () => {
      instanceRef.current = null;
      instance.unmount();
    };
  }, [renderer]);

  useLayoutEffect(() => {
    instanceRef.current?.update(frame);
  }, [frame]);

  useLayoutEffect(() => {
    if (fitRevision === undefined) return;
    instanceRef.current?.fit?.();
  }, [fitRevision]);

  return (
    <div
      className="world-map-renderer-host"
      data-world-map-presentation-tick={frame.tick}
      data-world-map-renderer={renderer.id}
      ref={(host) => {
        hostRef.current = host;
      }}
    />
  );
}
