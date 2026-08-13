import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { RunTimeline, TimelineEvent } from "../store/timeline.js";
import { ActionFeedPane } from "./ActionFeedPane.js";
import {
  registerActionNarrator,
  resetActionNarratorsForTests,
} from "./worldMapRendererCatalog.js";

const articlesWithClass = (html: string, className: string): string[] =>
  (html.match(/<article\b[\s\S]*?<\/article>/gu) ?? [])
    .filter((article) => article.includes(className));

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
  recordedAt: "2026-08-02T00:00:00.000Z",
  seq: t + 1,
  streamId: "causal:main",
  subjects: [],
  t,
  type,
  viewClass: "other",
});

const declaration = (
  actId: string,
  sequence: number,
  t: number,
): TimelineEvent[] => [
  event("dynamics.action.queued", `event:queued:${actId}`, t, {
    attempt: {
      act_id: actId,
      action: "b273-declare",
      actor: `entity:b273-form-${sequence}`,
      at_tick: 0,
      input: {},
      principal_id: `principal:b273-${sequence}`,
      target: "entity:b273-destination",
    },
    provenance: "external",
    receipt: {
      act_id: actId,
      apply_tick: 0,
      queued: true,
      sequence,
    },
  }),
  event("dynamics.action.applied", `event:applied:${actId}`, t + 1, {
    accepted: true,
    act_id: actId,
    action: "b273-declare",
    actor: `entity:b273-form-${sequence}`,
    apply_tick: 0,
    principal_id: `principal:b273-${sequence}`,
    provenance: "external",
    sequence,
    target: "entity:b273-destination",
  }),
];

const timeline = (): RunTimeline => ({
  elements: [],
  events: [
    ...declaration("act:b273-open", 1, 0),
    ...declaration("act:b273-resolved", 2, 2),
    event("dynamics.action.rejected_at_ingress", "event:b273-ingress", 4, {
      attempt: {
        act_id: "act:b273-ingress",
        action: "b273-declare",
        actor: "entity:b273-form-3",
        at_tick: 1,
        input: {},
        principal_id: "principal:b273-3",
      },
      provenance: "external",
      receipt: {
        act_id: "act:b273-ingress",
        apply_tick: 1,
        code: "b273-ingress-refusal",
        queued: false,
        sequence: 3,
      },
    }),
    event("dynamics.action.queued", "event:b273-mechanics-attempt", 5, {
      attempt: {
        act_id: "act:b273-mechanics",
        action: "b273-declare",
        actor: "entity:b273-form-4",
        at_tick: 2,
        input: {},
        principal_id: "principal:b273-4",
      },
      provenance: "external",
      receipt: {
        act_id: "act:b273-mechanics",
        apply_tick: 2,
        queued: true,
        sequence: 4,
      },
    }),
    event("dynamics.action.rejected_by_mechanics", "event:b273-mechanics", 6, {
      accepted: false,
      act_id: "act:b273-mechanics",
      action: "b273-declare",
      actor: "entity:b273-form-4",
      apply_tick: 2,
      message: "b273-mechanics-refusal",
      principal_id: "principal:b273-4",
      provenance: "external",
      sequence: 4,
    }),
    event("dynamics.commitment.outcome", "event:b273-outcome", 7, {
      commitment_id: "commitment:b273-2",
      counterparty: "entity:b273-peer",
      declaration_action_sequence: 2,
      outcome: "fulfilled",
      participant: "entity:b273-form-2",
      provenance: "mechanical",
      tick: 3,
    }),
  ],
  runId: "run:b273-feed",
  version: "simfile.run-timeline.v1",
});

test("renders record-decider roles and a symmetric standing block", () => {
  const html = renderToStaticMarkup(createElement(ActionFeedPane, {
    tick: 3,
    timeline: timeline(),
  }));

  assert.match(html, /feed-log-row feed-role-declared/u);
  assert.match(html, /feed-role-chip feed-role-declared[^>]*>[\s\S]*?&gt;[\s\S]*?declared/u);
  assert.match(html, /feed-log-row feed-role-derived/u);
  assert.match(html, /feed-role-chip feed-role-derived[^>]*>[\s\S]*?=[\s\S]*?derived/u);
  assert.equal(html.match(/feed-log-row feed-role-refused/gu)?.length, 2);
  assert.match(html, /feed-role-chip feed-role-refused[^>]*>[\s\S]*?x[\s\S]*?refused/u);
  assert.match(html, /b273-ingress-refusal/u);
  assert.match(html, /b273-mechanics-refusal/u);

  const logRows = articlesWithClass(html, "feed-log-row");
  const derivedRow = logRows.find((article) =>
    article.includes("feed-role-derived"));
  assert.ok(derivedRow);
  assert.match(
    derivedRow,
    />to<\/span>\s*<span title="entity:b273-peer">b273-peer<\/span>/u,
  );
  assert.match(
    derivedRow,
    /→ <span title="entity:b273-destination">b273-destination<\/span>/u,
  );
  assert.match(
    derivedRow,
    /<span class="feed-actor"><span title="entity:b273-form-2">b273-form-2<\/span><\/span>/u,
  );
  assert.match(html, /feed-standing-row feed-role-declared/u);
  assert.match(html, /feed-resolution-badge feed-role-derived/u);

  assert.match(html, /aria-label="declared action at tick/u);
  assert.match(html, /aria-label="derived outcome at tick/u);
  assert.match(html, /aria-label="refused action at tick/u);
  assert.match(html, /aria-label="declared standing commitment at tick/u);
});

test("derives category counts from the whole log and marks future categories inert", () => {
  const atStart = renderToStaticMarkup(createElement(ActionFeedPane, {
    tick: 0,
    timeline: timeline(),
  }));
  assert.match(atStart, /aria-label="Action feed categories" role="group"/u);
  assert.match(
    atStart,
    /<span>declared b273 declare<\/span><span class="feed-filter-count">2<\/span>/u,
  );
  assert.equal(atStart.match(/feed-filter-option-empty/gu)?.length, 2);
  assert.equal(atStart.match(/aria-disabled="true" disabled=""/gu)?.length, 2);
  assert.equal(atStart.match(/>none yet<\/span>/gu)?.length, 2);

  const atEnd = renderToStaticMarkup(createElement(ActionFeedPane, {
    tick: 3,
    timeline: timeline(),
  }));
  assert.match(atEnd, /<span>declared b273 declare<\/span>[\s\S]*?>2<\/span>/u);
  assert.match(atEnd, /<span>derived b273 declare<\/span>[\s\S]*?>1<\/span>/u);
  assert.match(atEnd, /<span>refused b273 declare<\/span>[\s\S]*?>2<\/span>/u);
  assert.doesNotMatch(atEnd, /feed-filter-option-empty|none yet/u);
  assert.match(atEnd, /0 hidden by filters/u);
});

test("a derived narration focuses its recorded participant", () => {
  const run = timeline();
  run.elements = [{
    kind: "agent",
    label: "B273 form",
    ref: "entity:b273-form-2",
  }];
  registerActionNarrator("b273-derived-focus", ({ row }) =>
    row.phase === "commitment" ? { text: "B273 derived narration" } : undefined);
  try {
    const html = renderToStaticMarkup(createElement(ActionFeedPane, {
      tick: 3,
      timeline: run,
    }));
    const derivedRow = articlesWithClass(html, "feed-log-row")
      .find((article) => article.includes("feed-role-derived"));
    assert.ok(derivedRow);
    assert.match(
      derivedRow,
      /<span class="feed-actor"><button class="feed-participant"[^>]*title="entity:b273-form-2"/u,
    );
    assert.match(
      derivedRow,
      /<button class="feed-inline-button"[^>]*title="entity:b273-form-2 · principal:b273-2/u,
    );
    assert.match(derivedRow, /declared t0/u);
  } finally {
    resetActionNarratorsForTests();
  }
});
