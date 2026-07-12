import { useMemo, useState } from "react";

import {
  agentsForMembrane,
  banksForMembrane,
  eventsForElement,
  focusAndOpenPortal,
  useTimelineStore,
  type RunTimeline,
  type RunTimelineMembrane,
} from "../store/timeline.js";
import { AsciiMap } from "../viewer/AsciiMap.js";
import { ChatPane, MindsRail } from "../viewer/ReplayPanes.js";
import { defaultRenderSettings } from "../viewer/renderSettings.js";
import { buildViewerWorld, viewerSkins } from "../viewer/worldModel.js";
import { StorylineRows } from "./StorylineRows.js";

/**
 * The membrane interior view (`VIEW_DESIGN.md` rule 5, "descend into a
 * mind"): a mini map + the interior room's chat + a minds rail filtered to
 * the membrane's own members, all reading the SAME store cursor as the outer
 * map/chat/minds (rule 7 — nothing here keeps a private clock). A "crossings"
 * tab keeps the membrane's own flat storyline available (the representative's
 * combined interior+exterior storyline — "the events where interior meets
 * exterior"), reusing `StorylineRows` rather than a second row renderer.
 */

type MembraneTab = "interior" | "crossings";

export function MembraneView({ timeline, membrane }: { timeline: RunTimeline; membrane: RunTimelineMembrane }) {
  const { cursor, selection, highlightedEventIds } = useTimelineStore();
  const [tab, setTab] = useState<MembraneTab>("interior");

  const interiorRoomSet = useMemo(() => new Set(membrane.interiorRooms), [membrane]);
  const interiorAgents = useMemo(() => agentsForMembrane(timeline, membrane.ref), [timeline, membrane]);
  const interiorBanks = useMemo(() => banksForMembrane(timeline, membrane.ref), [timeline, membrane]);
  const crossingRows = useMemo(() => eventsForElement(timeline, membrane.representative), [timeline, membrane]);

  const interiorWorld = useMemo(
    () => (membrane.interiorWorld ? buildViewerWorld(membrane.interiorWorld) : null),
    [membrane],
  );
  const skin = viewerSkins[0]!;
  const selectedNode = useMemo(
    () => interiorWorld?.nodes.find((node) => node.scope === selection) ?? interiorWorld?.nodes[0] ?? null,
    [interiorWorld, selection],
  );

  return (
    <div className="membrane-view">
      <div className="membrane-tabs" role="tablist">
        <button
          className={`membrane-tab ${tab === "interior" ? "active" : ""}`}
          onClick={() => setTab("interior")}
          role="tab"
          aria-selected={tab === "interior"}
          type="button"
        >
          interior
        </button>
        <button
          className={`membrane-tab ${tab === "crossings" ? "active" : ""}`}
          onClick={() => setTab("crossings")}
          role="tab"
          aria-selected={tab === "crossings"}
          type="button"
        >
          crossings
        </button>
      </div>

      {tab === "interior" ? (
        <>
          <div className="membrane-interior-map">
            {interiorWorld && selectedNode ? (
              <AsciiMap
                nodes={interiorWorld.nodes}
                onSelect={(id) => {
                  const node = interiorWorld.nodes.find((candidate) => candidate.id === id);
                  if (node) focusAndOpenPortal(node.scope);
                }}
                renderSettings={defaultRenderSettings}
                roomPaths={interiorWorld.roomPaths}
                rooms={interiorWorld.roomGeometries}
                selectedNode={selectedNode}
                selectedSkin={skin}
              />
            ) : null}
          </div>
          <ChatPane cursor={cursor} roomFilter={interiorRoomSet} timeline={timeline} />
          <MindsRail agents={interiorAgents} banks={interiorBanks} cursor={cursor} timeline={timeline} />
        </>
      ) : (
        <div className="membrane-crossings">
          <StorylineRows cursor={cursor} highlightedEventIds={highlightedEventIds} rows={crossingRows} timeline={timeline} />
        </div>
      )}
    </div>
  );
}
