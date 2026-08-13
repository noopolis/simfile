import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, it } from "node:test";

import type { RunTimeline, TimelineEvent } from "../store/timeline.js";
import { MindsRail } from "./ReplayPanes.js";
import {
  registerActionNarrator,
  resetActionNarratorsForTests,
} from "./actionNarrators.js";

const baseEvent = (overrides: Partial<TimelineEvent>): TimelineEvent => ({
  authority: "dynamics",
  causes: [],
  eventId: "event:base",
  payload: {},
  recordedAt: "2026-08-02T00:00:00.000Z",
  seq: 1,
  streamId: "causal:main",
  subjects: [],
  t: 0,
  type: "other",
  viewClass: "other",
  ...overrides,
});

const acts = ({
  actor,
  line,
  note,
  participant,
  sequence,
  t,
  tick,
}: {
  actor: string;
  line: string;
  note: string;
  participant: string;
  sequence: number;
  t: number;
  tick: number;
}): TimelineEvent[] => {
  const actId = `act:${sequence}`;
  return [
    baseEvent({
      eventId: `event:queued:${sequence}`,
      payload: {
        attempt: {
          act_id: actId,
          action: "commit",
          actor,
          at_tick: tick,
          input: { line, note, valid_for_ticks: 20 },
          principal_id: participant,
          target: actor,
        },
        receipt: { act_id: actId, apply_tick: tick, queued: true, sequence },
      },
      seq: sequence * 2,
      t,
      type: "dynamics.action.queued",
    }),
    baseEvent({
      eventId: `event:applied:${sequence}`,
      payload: {
        accepted: true,
        act_id: actId,
        action: "commit",
        actor,
        apply_tick: tick,
        principal_id: participant,
        sequence,
        target: actor,
      },
      seq: sequence * 2 + 1,
      t: t + 1,
      type: "dynamics.action.applied",
    }),
  ];
};

const timeline = (events: TimelineEvent[]): RunTimeline => ({
  elements: [],
  events,
  runId: "run:recorded-minds",
  version: "simfile.run-timeline.v1",
});

beforeEach(() => {
  resetActionNarratorsForTests();
});

describe("MindsRail", () => {
  it("keeps eight recorded principals distinct in the compact index", () => {
    registerActionNarrator("test-recorded", ({ row }) =>
      typeof row.input?.line === "string" ? {
        note: String(row.input.note),
        text: row.input.line,
      } : undefined);
    const run = timeline([
      ...acts({ actor: "object:participant.blue", line: "Blue commits", note: "condition A", participant: "controller:blue-mind", sequence: 1, t: 0, tick: 0 }),
      ...acts({ actor: "object:participant.blue", line: "Blue calls", note: "condition B", participant: "controller:blue-coordination", sequence: 2, t: 2, tick: 0 }),
      ...acts({ actor: "object:participant.blue-held", line: "Blue held commits", note: "condition C", participant: "controller:blue-held-mind", sequence: 3, t: 4, tick: 1 }),
      ...acts({ actor: "object:participant.blue-held", line: "Blue held calls", note: "condition D", participant: "controller:blue-held-coordination", sequence: 4, t: 6, tick: 1 }),
      ...acts({ actor: "object:participant.red", line: "Red commits", note: "condition E", participant: "controller:red-mind", sequence: 5, t: 8, tick: 2 }),
      ...acts({ actor: "object:participant.red", line: "Red calls", note: "condition F", participant: "controller:red-coordination", sequence: 6, t: 10, tick: 2 }),
      ...acts({ actor: "object:participant.red-held", line: "Red held commits", note: "condition G", participant: "controller:red-held-mind", sequence: 7, t: 12, tick: 3 }),
      ...acts({ actor: "object:participant.red-held", line: "Red held calls", note: "condition H", participant: "controller:red-held-coordination", sequence: 8, t: 14, tick: 3 }),
    ]);
    const html = renderToStaticMarkup(createElement(MindsRail, {
      cursor: run.events.length - 1,
      timeline: run,
    }));
    for (const name of [
      "blue-mind", "blue-coordination",
      "blue-held-mind", "blue-held-coordination",
      "red-mind", "red-coordination",
      "red-held-mind", "red-held-coordination",
    ]) {
      assert.match(
        html,
        new RegExp(`<span class="mind-row-name">${name}</span><span class="mind-row-stat">1 wakes</span><span class="mind-row-stat">1 live</span>`, "u"),
        name,
      );
    }
    assert.equal((html.match(/class="mind-row"/gu) ?? []).length, 8);
    assert.equal((html.match(/class="mind-row-open">open/gu) ?? []).length, 8);
    assert.doesNotMatch(html, /Blue commits|condition A|stratum-wake/u);
  });

  it("keeps the stream-agent memory markup unchanged", () => {
    const run: RunTimeline = {
      elements: [{ kind: "agent", label: "Alpha", ref: "agent:alpha" }],
      events: [baseEvent({
        authority: "memory",
        eventId: "event:memory",
        subjects: ["agent:alpha"],
        text: "retained fact",
        type: "memory.observed",
        viewClass: "memory.observed",
      })],
      runId: "run:memory",
      version: "simfile.run-timeline.v1",
    };
    assert.equal(
      renderToStaticMarkup(createElement(MindsRail, { cursor: 0, timeline: run })),
      '<aside class="replay-pane replay-minds" aria-label="Minds rail"><header class="replay-pane-header">minds · 1</header><div class="replay-pane-body"><div class="mind-portal"><button class="mind-header" type="button">Alpha  <span>1</span></button><ol class="mind-strata"><li class="stratum-observed"><span class="stratum-kind">observed</span><span class="stratum-text">retained fact</span></li></ol></div></div></aside>',
    );
  });
});
