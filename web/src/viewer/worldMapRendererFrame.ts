import type { WorldMapRendererFrame } from "./WorldMapRendererHost.js";
import type { ViewerNode, ViewerSpatialSample } from "./types.js";

export const buildWorldMapRendererFrame = (input: Readonly<{
  nodes: readonly ViewerNode[];
  onSelect: (id: string) => void;
  selectedNodeId: string;
  spatialSamples: readonly ViewerSpatialSample[];
  tick: number;
  tickDurationMs: number;
  extensionData?: unknown;
  extensionIdentities?: WorldMapRendererFrame["extensionIdentities"];
  cursor?: WorldMapRendererFrame["cursor"];
}>): WorldMapRendererFrame => Object.freeze({
  nodes: input.nodes,
  onSelect: input.onSelect,
  selectedNodeId: input.selectedNodeId,
  spatialSamples: input.spatialSamples,
  tick: input.tick,
  tickDurationMs: input.tickDurationMs,
  ...(input.extensionData === undefined ? {} : { extensionData: input.extensionData }),
  ...(input.extensionIdentities === undefined ? {} : { extensionIdentities: input.extensionIdentities }),
  ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
});
