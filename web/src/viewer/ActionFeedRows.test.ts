import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { RunTimeline } from "../store/timeline.js";
import { ActionLogRow, StandingCommitmentRow } from "./ActionFeedRows.js";
import type { ActionLogEntry } from "./actionLog.js";
import {
  registerActionNarrator,
  resetActionNarratorsForTests,
} from "./actionNarrators.js";
import type { CommitmentSpan } from "./commitmentSpans.js";

const timeline: RunTimeline = {
  elements: [],
  events: [],
  runId: "run:feed-rows",
  version: "simfile.run-timeline.v1",
};

const entry = (
  overrides: Partial<ActionLogEntry> = {},
): ActionLogEntry => ({
  actId: "act:row",
  eventId: "event:row",
  outcome: "accepted",
  participant: "controller:observer",
  phase: "action",
  provenance: "external",
  t: 1,
  tick: 2,
  verb: "record_action",
  ...overrides,
});

const renderEntry = (value: ActionLogEntry): string =>
  renderToStaticMarkup(createElement(ActionLogRow, { entry: value, timeline }));

const summaryOf = (html: string): string => {
  const summary = html.match(/<summary\b[\s\S]*?<\/summary>/u)?.[0];
  assert.ok(summary);
  return summary;
};

afterEach(() => resetActionNarratorsForTests());

describe("ActionFeedRows disclosure", () => {
  it("keeps mechanics, facts, validity, and detail out of the visible headline", () => {
    const html = renderEntry(entry({
      cause: "constrained:gain_control_before_kick",
      detail: "recorded detail",
      input: { destination: { x: 1, y: 2 }, valid_for_ticks: 5 },
      validUntilTick: 7,
    }));
    const summary = summaryOf(html);
    assert.match(summary, /title="record_action"/u);
    assert.doesNotMatch(
      summary,
      /mechanics:|constrained:gain_control_before_kick|destination:|until t7|recorded detail/u,
    );
    assert.match(html, /class="feed-what-detail"/u);
    assert.match(html, /destination: \(1, 2\), valid for ticks: 5/u);
    assert.match(html, /until t7/u);
    assert.match(html, /mechanics: constrained:gain_control_before_kick/u);
    assert.match(html, /\(recorded detail\)/u);
  });

  it("renders no disclosure marker when the headline has no extra facts", () => {
    const html = renderEntry(entry());
    assert.doesNotMatch(html, /<details|<summary/u);
    assert.match(
      html,
      /<span class="feed-what feed-headline" title="record_action">/u,
    );
  });

  it("keeps a refused cause on the headline", () => {
    const html = renderEntry(entry({
      cause: "record-refusal",
      detail: "at ingress",
      outcome: "rejected",
    }));
    assert.match(summaryOf(html), /refused: record-refusal/u);
    assert.equal(html.match(/record-refusal/gu)?.length, 2);
  });

  it("puts standing declaration context behind the same disclosure", () => {
    const span: CommitmentSpan = {
      actId: "act:standing",
      actor: "object:body",
      counterparty: "controller:peer",
      declaredAtTick: 2,
      eventId: "event:standing",
      participant: "controller:observer",
      sequence: 1,
      t: 1,
      target: "object:destination",
      verb: "record_action",
    };
    const html = renderToStaticMarkup(createElement(StandingCommitmentRow, {
      span,
      timeline,
    }));
    const summary = summaryOf(html);
    assert.match(summary, /record_action[\s\S]*to[\s\S]*peer[\s\S]*→[\s\S]*destination/u);
    assert.doesNotMatch(summary, /via|declared t2/u);
    assert.match(html, /feed-what-detail[\s\S]*via[\s\S]*declared t2/u);
  });
});

describe("ActionFeedRows message form", () => {
  it("renders registered message text in full without truncation styles", () => {
    const message = "A complete authored message that may wrap across the available column.";
    registerActionNarrator("message-test", () => ({
      form: "message",
      note: "record context",
      text: message,
    }));
    const html = renderEntry(entry({
      cause: "record-mechanics",
      input: { context: "record fact" },
      validUntilTick: 9,
    }));
    const summary = summaryOf(html);
    assert.match(summary, /class="feed-headline feed-headline-message"/u);
    assert.match(summary, new RegExp(message.replaceAll(".", "\\."), "u"));
    assert.doesNotMatch(summary, /record context|record fact|until t9|record-mechanics/u);
    assert.match(html, /record context[\s\S]*context: record fact[\s\S]*until t9[\s\S]*record-mechanics/u);

    const css = readFileSync(
      new URL("../styles-replay.css", import.meta.url),
      "utf8",
    );
    assert.match(
      css,
      /\.feed-headline-message\s*\{[^}]*overflow: visible;[^}]*text-overflow: clip;[^}]*white-space: normal;/su,
    );
  });
});

describe("B279 one-line rule", () => {
  /**
   * The markup alone cannot keep a row one line tall: a declaration headline is
   * held to a single line by CSS, so deleting that rule restores the unreadable
   * wrapped feed with every rendering assertion still green. Pin the rule where
   * it lives, the same way the message form pins its opposite.
   */
  it("holds the declaration headline to one line in the stylesheet", () => {
    const css = readFileSync(
      new URL("../styles-replay.css", import.meta.url),
      "utf8",
    );
    const headline = css.match(/\.feed-headline\s*\{[^}]*\}/u)?.[0];
    assert.ok(headline, "the .feed-headline rule must exist");
    assert.match(headline, /white-space: nowrap;/u);
    assert.match(headline, /overflow: hidden;/u);
    assert.match(headline, /text-overflow: ellipsis;/u);
    // Ellipsis in a grid/flex column is inert without this on the row's cell.
    assert.match(headline, /min-width: 0;/u);
    assert.match(css, /\.feed-what\s*\{[^}]*min-width: 0;/u);
  });
});

describe("B278 role-word guard", () => {
  it("renders each role's glyph, word, and word-bearing aria-label", () => {
    const cases = [
      [entry(), "declared", "&gt;"],
      [entry({ outcome: "fulfilled", phase: "commitment", provenance: "mechanical" }), "derived", "="],
      [entry({ outcome: "rejected" }), "refused", "x"],
    ] as const;
    for (const [value, word, glyph] of cases) {
      const html = renderEntry(value);
      const expected = `<span class="feed-role-chip feed-role-${word}" aria-label="${word} role"><span aria-hidden="true">${glyph}</span> ${word}</span>`;
      assert.ok(html.includes(expected), `${word} role chip lost visible or accessible text`);
    }
  });
});
