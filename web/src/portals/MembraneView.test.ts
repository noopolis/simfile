import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { derivePlaybackCadence } from "../chrome/playbackCadence.js";
import {
  loadTimeline,
  resetTimelineStoreForTests,
  setCursor,
  type RunTimeline,
  type RunTimelineMembrane,
  type TimelineEvent,
} from "../store/timeline.js";
import { AsciiMap } from "../viewer/AsciiMap.js";
import { defaultRenderSettings } from "../viewer/renderSettings.js";
import type { ViewerContractTrace } from "../viewer/types.js";
import { tickAtCursor } from "../viewer/variableModel.js";
import { buildViewerWorld, viewerSkins } from "../viewer/worldModel.js";
import { MembraneView } from "./MembraneView.js";

// The root tsconfig.json declares no `jsx`, so tsx transpiles `.tsx` with the
// classic runtime and the emitted `React.createElement` resolves against the
// global at render time. The vite build uses tsconfig.web.json's automatic
// runtime and is unaffected. P3 note: giving the root tsconfig `"jsx":
// "react-jsx"` would remove the need for this line; out of B210's scope.
(globalThis as Record<string, unknown>).React = React;

const measuredTickDurationMs = 50;
const measuredLastTick = 2_000;
const eventsPerTick = 9;
const measuredEventCount = measuredLastTick * eventsPerTick + 2;

const roomARef = "room:inner:room-a";
const roomBRef = "room:inner:room-b";
const agentRef = "agent:traveler";

const interiorTrace = ({
  lastPresenceTick,
  presenceStep,
  tickDurationMs,
  withSpatialSpan,
}: {
  lastPresenceTick: number;
  presenceStep: number;
  tickDurationMs: number;
  withSpatialSpan: boolean;
}): ViewerContractTrace => ({
  version: "viewer.trace.v1",
  run_id: "neutral-record",
  run_name: "neutral-record",
  rooms: [
    {
      id: "room-a",
      label: "Room A",
      members: ["traveler"],
      scene: [-7, 0, 0],
      scope: roomARef,
    },
    {
      id: "room-b",
      label: "Room B",
      members: ["traveler"],
      scene: [7, 0, 0],
      scope: roomBRef,
    },
  ],
  corridors: [],
  agents: [{ id: "traveler", label: "Traveler", scope: agentRef }],
  presence: Array.from(
    { length: Math.floor(lastPresenceTick / presenceStep) + 1 },
    (_, index) => ({
      actor: "traveler",
      room: index % 2 === 0 ? "room-a" : "room-b",
      tick: index * presenceStep,
      type: "presence.arrived" as const,
    }),
  ),
  ledger_facts: [],
  signals: [],
  spatial_samples: withSpatialSpan
    ? [
        { occupancy: {}, tick: 0, transit: [] },
        { occupancy: {}, tick: measuredLastTick, transit: [] },
      ]
    : undefined,
  tick_duration_ms: tickDurationMs,
});

const membraneFor = (trace: ViewerContractTrace, ref: string): RunTimelineMembrane => ({
  ref,
  label: "Interior",
  representative: agentRef,
  interiorRooms: [roomARef, roomBRef],
  members: [agentRef],
  interiorWorld: trace,
});

const eventAt = (t: number, tick: number, recordedAt: string): TimelineEvent => ({
  t,
  eventId: `event-${t}`,
  authority: "neutral",
  streamId: "neutral-stream",
  seq: t + 1,
  type: "record.observed",
  viewClass: "other",
  recordedAt,
  subjects: [],
  causes: [],
  payload: { value: tick % 3 },
});

const timelineFor = (
  runId: string,
  events: TimelineEvent[],
  membrane: RunTimelineMembrane,
): RunTimeline => ({
  version: "simfile.run-timeline.v1",
  runId,
  events,
  elements: [
    { ref: membrane.ref, kind: "team", label: membrane.label },
    { ref: roomARef, kind: "room", label: "Room A" },
    { ref: roomBRef, kind: "room", label: "Room B" },
    { ref: agentRef, kind: "agent", label: "Traveler" },
  ],
  membranes: [membrane],
});

const buildMeasuredFixture = () => {
  const trace = interiorTrace({
    lastPresenceTick: 1_950,
    presenceStep: 50,
    tickDurationMs: measuredTickDurationMs,
    withSpatialSpan: true,
  });
  const membrane = membraneFor(trace, "membrane:measured");
  const events: TimelineEvent[] = [];
  const expectedTicks: number[] = [];
  const append = (tick: number): void => {
    expectedTicks.push(tick);
    events.push(eventAt(events.length, tick, new Date(tick * trace.tick_duration_ms!).toISOString()));
  };

  append(0);
  for (let tick = 1; tick <= measuredLastTick; tick += 1) {
    for (let event = 0; event < eventsPerTick; event += 1) append(tick);
  }
  append(measuredLastTick);

  return {
    cadence: derivePlaybackCadence({
      eventCount: events.length,
      events,
      firstTick: trace.spatial_samples?.[0]?.tick,
      lastTick: trace.spatial_samples?.at(-1)?.tick,
      speed: 1,
      tickDurationMs: trace.tick_duration_ms,
    }),
    expectedTicks,
    membrane,
    timeline: timelineFor("measured-record", events, membrane),
  };
};

const extractInteriorMap = (markup: string): string => {
  const start = markup.indexOf('<div class="membrane-interior-map">');
  const end = markup.indexOf('<section class="replay-pane replay-chat"', start);
  assert.notEqual(start, -1, "membrane interior map wrapper must render");
  assert.notEqual(end, -1, "chat pane must follow the membrane interior map");
  return markup.slice(start, end);
};

const renderMembraneInterior = (
  timeline: RunTimeline,
  membrane: RunTimelineMembrane,
  tick: number | undefined,
  cursor: number,
): string => {
  loadTimeline(timeline);
  setCursor(cursor);
  return extractInteriorMap(renderToStaticMarkup(createElement(MembraneView, {
    membrane,
    tick,
    timeline,
  })));
};

const renderDirectInterior = (
  membrane: RunTimelineMembrane,
  tick: number | undefined,
): string => {
  assert.ok(membrane.interiorWorld);
  const world = buildViewerWorld(membrane.interiorWorld);
  const mapProps = {
    nodes: world.nodes,
    onSelect: () => undefined,
    renderSettings: defaultRenderSettings,
    roomPaths: world.roomPaths,
    rooms: world.roomGeometries,
    selectedNode: world.nodes[0]!,
    selectedSkin: viewerSkins[0]!,
    presenceByAgent: world.presenceByAgent,
    spatialSamples: world.spatialSamples,
    tickDurationMs: world.tickDurationMs,
  };
  const map = tick === undefined
    ? createElement(AsciiMap, mapProps)
    : createElement(AsciiMap, { ...mapProps, tick });
  return renderToStaticMarkup(createElement("div", { className: "membrane-interior-map" }, map));
};

describe("MembraneView world tick", () => {
  beforeEach(() => resetTimelineStoreForTests());

  it("matches the outer map's one tick accessor across the measured cursor range", () => {
    const fixture = buildMeasuredFixture();
    assert.equal(fixture.timeline.events.length, measuredEventCount);
    assert.ok(fixture.cadence.simulatedTimeIndex, "fixture clock must be corroborated");

    const firstTick = tickAtCursor(fixture.timeline, 0, fixture.cadence);
    const lastCursor = fixture.timeline.events.length - 1;
    const lastTick = tickAtCursor(fixture.timeline, lastCursor, fixture.cadence);
    const firstMap = renderMembraneInterior(fixture.timeline, fixture.membrane, firstTick, 0);
    const lastMap = renderMembraneInterior(fixture.timeline, fixture.membrane, lastTick, lastCursor);
    assert.notEqual(firstMap, lastMap, "fixture must discriminate between distinct world ticks");

    for (let cursor = 0; cursor <= lastCursor; cursor += 1) {
      assert.equal(
        tickAtCursor(fixture.timeline, cursor, fixture.cadence),
        fixture.expectedTicks[cursor],
        `world tick at cursor ${cursor}`,
      );
    }

    for (const cursor of [0, 1, 4_500, 9_000, 13_500, 18_000, lastCursor]) {
      const tick = tickAtCursor(fixture.timeline, cursor, fixture.cadence);
      assert.equal(
        renderMembraneInterior(fixture.timeline, fixture.membrane, tick, cursor),
        renderDirectInterior(fixture.membrane, tick),
        `interior map must equal the outer map render at cursor ${cursor}`,
      );
    }
  });

  it("rejects the event cursor where the simulated world tick belongs", () => {
    const fixture = buildMeasuredFixture();
    const cursor = 9_000;
    const tick = tickAtCursor(fixture.timeline, cursor, fixture.cadence);
    assert.equal(tick, 1_000);
    assert.equal(cursor / tick, eventsPerTick, "candidate ticks are ninefold apart");

    const actual = renderMembraneInterior(fixture.timeline, fixture.membrane, tick, cursor);
    assert.notEqual(actual, renderDirectInterior(fixture.membrane, cursor));
  });

  it("renders one timeless frame as the store cursor advances", () => {
    const trace = interiorTrace({
      lastPresenceTick: 3,
      presenceStep: 1,
      tickDurationMs: 75,
      withSpatialSpan: false,
    });
    const membrane = membraneFor(trace, "membrane:timeless");
    const events = Array.from({ length: 4 }, (_, cursor) => eventAt(cursor, cursor, ""));
    const timeline = timelineFor("timeless-record", events, membrane);
    const cadence = derivePlaybackCadence({ eventCount: events.length, events, speed: 1 });
    const cursors = [0, 1, 2, 3];

    const maps = cursors.map((cursor) => {
      const tick = tickAtCursor(timeline, cursor, cadence);
      assert.equal(tick, undefined, `record must state no time at cursor ${cursor}`);
      return renderMembraneInterior(timeline, membrane, tick, cursor);
    });
    assert.ok(maps.every((markup) => markup === maps[0]), "store cursor must not move a timeless map");

    const timelessFrame = renderDirectInterior(membrane, undefined);
    assert.equal(maps[0], timelessFrame);
    assert.notEqual(timelessFrame, renderDirectInterior(membrane, 0), "timeless frame is not tick 0");
  });
});
