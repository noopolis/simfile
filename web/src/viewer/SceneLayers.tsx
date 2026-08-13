import { memo } from "react";

import { AgentAvatar, CorridorMeshes, RoomMeshes, SignalMesh } from "./SceneGeometry.js";
import { AgentSceneLabels, StaticSceneLabels } from "./SceneLabels.js";
import { useAvatarModel } from "./avatarModel.js";
import type { RenderSettings } from "./renderSettings.js";
import type { AgentPlacement } from "./sceneMotion.js";
import type { RoomGeometry, RoomPath, ViewerNode } from "./types.js";
import type { ViewerSkin } from "./worldModel.js";

export const StaticSceneLayer = memo(function StaticSceneLayer({
  onSelect,
  paths,
  renderSettings,
  rooms,
  selectedNodeId,
  selectedSkin,
  signalNodes,
}: {
  onSelect: (id: string) => void;
  paths: RoomPath[];
  renderSettings: RenderSettings;
  rooms: RoomGeometry[];
  selectedNodeId: string;
  selectedSkin: ViewerSkin;
  signalNodes: ViewerNode[];
}) {
  return (
    <>
      {paths.map((path) => (
        <CorridorMeshes
          key={`${selectedSkin.id}:${path.id}`}
          path={path}
          renderSettings={renderSettings}
          skin={selectedSkin}
        />
      ))}
      {rooms.map((room) => (
        <RoomMeshes
          key={`${selectedSkin.id}:${room.id}`}
          paths={paths}
          renderSettings={renderSettings}
          room={room}
          selected={selectedNodeId === room.node.id}
          skin={selectedSkin}
        />
      ))}
      {signalNodes.map((node) => (
        <SignalMesh
          key={`${selectedSkin.id}:${node.id}`}
          node={node}
          skin={selectedSkin}
        />
      ))}
      {renderSettings.showLabels ? (
        <StaticSceneLabels
          onSelect={onSelect}
          renderSettings={renderSettings}
          rooms={rooms}
          selectedNodeId={selectedNodeId}
          signalNodes={signalNodes}
        />
      ) : null}
    </>
  );
});

export const AgentSceneLayer = memo(function AgentSceneLayer({
  agentPlacements,
  onSelect,
  renderSettings,
  selectedNodeId,
  selectedSkin,
  showModels = true,
}: {
  agentPlacements: AgentPlacement[];
  onSelect: (id: string) => void;
  renderSettings: RenderSettings;
  selectedNodeId: string;
  selectedSkin: ViewerSkin;
  showModels?: boolean;
}) {
  const avatarPolygons = useAvatarModel();
  return (
    <>
      {showModels ? agentPlacements.map((placement) => (
        <AgentAvatar
          key={`${selectedSkin.id}:${placement.node.id}`}
          placement={placement}
          polygons={avatarPolygons}
          renderSettings={renderSettings}
          selected={selectedNodeId === placement.node.id}
          skin={selectedSkin}
        />
      )) : null}
      {renderSettings.showLabels ? (
        <AgentSceneLabels
          agentPlacements={agentPlacements}
          onSelect={onSelect}
          renderSettings={renderSettings}
          selectedNodeId={selectedNodeId}
        />
      ) : null}
    </>
  );
});
