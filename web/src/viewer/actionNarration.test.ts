import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { RunTimeline, TimelineEvent } from "../store/timeline.js";
import { ActionFeedPane } from "./ActionFeedPane.js";
import type { ActionFeedRow, ActionOutcome } from "./actionFeed.js";
import {
  actionDecider,
  actionDeciderPresentation,
  actionLivePresentation,
  declarationFacts,
  displayName,
} from "./actionNarration.js";
import {
  narrateAction,
  registerActionNarrator,
  resetActionNarratorsForTests,
} from "./worldMapRendererCatalog.js";

const row: ActionFeedRow = {
  actId: "act:sample",
  eventId: "event:sample",
  outcome: "accepted",
  participant: "controller:unit.alpha-mind",
  phase: "action",
  t: 2,
  tick: 4,
  verb: "declare",
};

const event = (
  type: string,
  eventId: string,
  t: number,
  payload: unknown,
): TimelineEvent => ({
  authority: "dynamics",
  causes: [],
  eventId,
  payload,
  recordedAt: "2026-08-01T00:00:00.000Z",
  seq: t + 1,
  streamId: "causal:main",
  subjects: [],
  t,
  type,
  viewClass: "other",
});

const fallbackTimeline = (enumerateDeclarer = false): RunTimeline => ({
  elements: enumerateDeclarer ? [{
    kind: "agent",
    label: "Alpha",
    ref: "controller:unit.alpha-mind",
  }] : [],
  events: [event("dynamics.action.rejected_at_ingress", "event:rejected", 2, {
    attempt: {
      act_id: "act:rejected",
      action: "declare",
      actor: "object:unit.alpha",
      at_tick: 4,
      input: {
        destination: { x: 1.236, y: -2.5 },
        mode: "survey",
        valid_for_ticks: 5,
      },
      principal_id: "controller:unit.alpha-mind",
      target: "object:unit.beta",
    },
    receipt: {
      act_id: "act:rejected",
      apply_tick: 4,
      code: "not_available",
      queued: false,
      sequence: 3,
    },
  })],
  runId: "run:narration",
  version: "simfile.run-timeline.v1",
});

const acceptedTimeline = (): RunTimeline => ({
  elements: [],
  events: [
    event("dynamics.action.queued", "event:queued", 0, {
      attempt: {
        act_id: "act:accepted",
        action: "declare",
        actor: "object:unit.alpha",
        at_tick: 4,
        input: { mode: "survey", valid_for_ticks: 5 },
        principal_id: "controller:unit.alpha-mind",
      },
      receipt: {
        act_id: "act:accepted",
        apply_tick: 4,
        queued: true,
        sequence: 4,
      },
    }),
    event("dynamics.action.applied", "event:applied", 1, {
      accepted: true,
      act_id: "act:accepted",
      action: "declare",
      actor: "object:unit.alpha",
      apply_tick: 4,
      message: "ready",
      principal_id: "controller:unit.alpha-mind",
      sequence: 4,
    }),
  ],
  runId: "run:accepted-narration",
  version: "simfile.run-timeline.v1",
});

const resolvedTimeline = (): RunTimeline => ({
  elements: [],
  events: [
    event("dynamics.action.queued", "event:resolution-queued", 0, {
      attempt: {
        act_id: "act:resolution",
        action: "declare",
        actor: "object:unit.alpha",
        at_tick: 0,
        input: { mode: "survey", valid_for_ticks: 100 },
        principal_id: "controller:unit.alpha-mind",
      },
      receipt: {
        act_id: "act:resolution",
        apply_tick: 0,
        queued: true,
        sequence: 8,
      },
    }),
    event("dynamics.action.applied", "event:resolution-applied", 1, {
      accepted: true,
      act_id: "act:resolution",
      action: "declare",
      actor: "object:unit.alpha",
      apply_tick: 0,
      principal_id: "controller:unit.alpha-mind",
      sequence: 8,
    }),
    event("dynamics.commitment.outcome", "event:resolution", 2, {
      commitment_id: "commitment:resolution",
      declaration_action_sequence: 8,
      outcome: "expired",
      participant: "object:unit.alpha",
      tick: 10,
    }),
  ],
  runId: "run:resolved-narration",
  version: "simfile.run-timeline.v1",
});

const renderTimeline = (timeline: RunTimeline, tick = 4): string =>
  renderToStaticMarkup(createElement(
  ActionFeedPane,
  { tick, timeline },
));

const renderFallbackTimeline = (enumerateDeclarer = false): string =>
  renderTimeline(fallbackTimeline(enumerateDeclarer));

afterEach(() => resetActionNarratorsForTests());

describe("actionDecider", () => {
  const outcomes: readonly ActionOutcome[] = [
    "accepted", "rejected", "pending", "fulfilled", "expired", "abandoned",
    "matched", "unmatched",
  ];
  const phases: readonly ActionFeedRow["phase"][] = ["action", "commitment"];
  const provenances: readonly (string | undefined)[] =
    [undefined, "mechanical", "external", "record-stated"];

  it("covers every outcome, phase, and stated-or-absent provenance", () => {
    for (const outcome of outcomes) {
      for (const phase of phases) {
        for (const provenance of provenances) {
          const sample = {
            ...row,
            outcome,
            phase,
            ...(provenance === undefined ? {} : { provenance }),
          };
          const expected = outcome === "rejected"
            ? "refused"
            : provenance === "mechanical"
            ? "derived"
            : provenance !== undefined
            ? "declared"
            : phase === "commitment"
            ? "derived"
            : "declared";
          assert.equal(
            actionDecider(sample),
            expected,
            `${outcome}/${phase}/${provenance ?? "absent"}`,
          );
        }
      }
    }
  });

  it("maps every role to its shared ASCII presentation", () => {
    assert.deepEqual(actionDeciderPresentation("declared"), {
      className: "feed-role-declared",
      decider: "declared",
      glyph: ">",
      word: "declared",
    });
    assert.deepEqual(actionDeciderPresentation("derived"), {
      className: "feed-role-derived",
      decider: "derived",
      glyph: "=",
      word: "derived",
    });
    assert.deepEqual(actionDeciderPresentation("refused"), {
      className: "feed-role-refused",
      decider: "refused",
      glyph: "x",
      word: "refused",
    });
  });

  it("uses model origin only as a declared-row visual state", () => {
    assert.deepEqual(actionLivePresentation(row, { provenance: "agentic" }), {
      className: "feed-role-live",
      isLive: true,
      token: " live",
    });
    assert.equal(
      actionLivePresentation(row, { live_acceptance: true }).isLive,
      true,
    );
    assert.equal(
      actionLivePresentation(row, { provenance: "scripted" }).isLive,
      false,
    );
    assert.equal(actionLivePresentation(row).isLive, false);
    assert.equal(
      actionLivePresentation({ ...row, provenance: "mechanical" }, {
        provenance: "agentic",
      }).isLive,
      false,
    );
    assert.equal(
      actionLivePresentation({ ...row, outcome: "rejected" }, {
        live_acceptance: true,
      }).isLive,
      false,
    );
  });
});

describe("displayName", () => {
  it("takes only the final structural address segment", () => {
    assert.equal(displayName("object:unit.alpha"), "alpha");
    assert.equal(displayName("controller:alpha-mind"), "alpha-mind");
    assert.equal(displayName("unchanged"), "unchanged");
  });
});

describe("declarationFacts", () => {
  it("preserves insertion order, flattens objects and formats exact points", () => {
    assert.deepEqual(declarationFacts({
      mode: "survey",
      destination: { x: 1.236, y: -2.5 },
      success: { kind: "arrive", min_score: 2 },
      valid_for_ticks: 10,
      enabled: false,
    }), [
      { label: "mode", value: "survey" },
      { label: "destination", value: "(1.24, -2.5)" },
      { label: "success.kind", value: "arrive" },
      { label: "success.min score", value: "2" },
      { label: "valid for ticks", value: "10" },
      { label: "enabled", value: "false" },
    ]);
  });

  it("omits arrays, null, non-finite values and cyclic objects", () => {
    const nested: Record<string, unknown> = {
      array: [1, 2],
      finite: 3,
      infinite: Number.POSITIVE_INFINITY,
      nil: null,
    };
    nested.self = nested;
    assert.deepEqual(declarationFacts({ nested, invalid: Number.NaN }), [
      { label: "nested.finite", value: "3" },
    ]);
    assert.deepEqual(declarationFacts(null), []);
  });

  it("does not treat an object with an extra key as a point", () => {
    assert.deepEqual(declarationFacts({ value: { x: 1, y: 2, unit: "m" } }), [
      { label: "value.x", value: "1" },
      { label: "value.y", value: "2" },
      { label: "value.unit", value: "m" },
    ]);
  });

  it("rounds decimal ties and trims coordinate zeros", () => {
    assert.deepEqual(declarationFacts({ point: { x: 1.005, y: -0 } }), [
      { label: "point", value: "(1.01, 0)" },
    ]);
  });
});

describe("action narrator catalog", () => {
  it("returns undefined with no registration and rejects bad or duplicate ids", () => {
    assert.equal(narrateAction({ row }), undefined);
    assert.throws(
      () => registerActionNarrator("Bad_Id", () => ({ text: "unused" })),
      /invalid or duplicate/u,
    );
    registerActionNarrator("sample-extension", () => undefined);
    assert.throws(
      () => registerActionNarrator("sample-extension", () => ({ text: "unused" })),
      /invalid or duplicate/u,
    );
  });

  it("uses the first non-blank narration and isolates a throwing narrator", () => {
    registerActionNarrator("throws", () => {
      throw new Error("fixture failure");
    });
    registerActionNarrator("blank", () => ({ text: "  " }));
    registerActionNarrator("claims", () => ({ note: "recorded", text: "Readable" }));
    registerActionNarrator("later", () => ({ text: "Too late" }));
    assert.deepEqual(narrateAction({ row }), { note: "recorded", text: "Readable" });
  });
});

describe("ActionFeedPane narration", () => {
  it("uses the generic participant, verb and facts path when nobody claims", () => {
    const html = renderFallbackTimeline();
    assert.match(html, /title="controller:unit\.alpha-mind">alpha-mind</u);
    assert.match(html, /title="object:unit\.alpha">alpha</u);
    assert.match(html, /declare/u);
    assert.match(html, /destination: \(1\.24, -2\.5\), mode: survey, valid for ticks: 5/u);
    assert.match(html, /until t9/u);
    assert.match(html, /refused: not_available/u);
    assert.match(html, /\(at ingress\)/u);
    assert.match(html, /aria-label="rejected at tick 4"/u);
  });

  it("falls back safely when a registered narrator throws during rendering", () => {
    registerActionNarrator("throwing-extension", () => {
      throw new Error("broken presentation");
    });
    const html = renderFallbackTimeline();
    assert.match(html, /alpha-mind/u);
    assert.match(html, /destination: \(1\.24, -2\.5\)/u);
    assert.match(html, />rejected<\/button>/u);
  });

  it("renders claimed text and note while keeping time and outcome controls", () => {
    registerActionNarrator("claiming-extension", () => ({
      note: "from the declaration",
      text: "Alpha states a route",
    }));
    const html = renderFallbackTimeline();
    assert.match(html, /Alpha states a route/u);
    assert.match(html, /from the declaration/u);
    assert.match(html, /destination: \(1\.24, -2\.5\)/u);
    assert.match(html, /t4/u);
    assert.match(html, /aria-label="rejected at tick 4"/u);
    assert.match(html, /<span[^>]*>Alpha states a route<\/span>/u);
    assert.doesNotMatch(html, /<button[^>]*>Alpha states a route<\/button>/u);
  });

  it("labels accepted mechanics messages without using the refusal label", () => {
    const html = renderTimeline(acceptedTimeline());
    assert.match(html, /mechanics: ready/u);
    assert.doesNotMatch(html, /refused:/u);
  });

  it("never repeats a declaration validity window on its resolution row", () => {
    const html = renderTimeline(resolvedTimeline(), 10);
    assert.equal(html.match(/until t100/gu)?.length, 1);
    assert.match(html, /expired/u);
    assert.match(html, /declared t0/u);
  });

  it("keeps claimed narration clickable when the declarer has a portal ref", () => {
    registerActionNarrator("portal-extension", () => ({
      text: "Alpha states a route",
    }));
    const html = renderFallbackTimeline(true);
    assert.match(
      html,
      /<button[^>]*title="controller:unit\.alpha-mind[^>]*>Alpha states a route<\/button>/u,
    );
  });
});
