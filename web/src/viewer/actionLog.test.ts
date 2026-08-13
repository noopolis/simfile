import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RunTimeline, TimelineEvent } from "../store/timeline.js";
import {
  actionLogAtTick,
  actionLogUpToTick,
  buildActionLog,
} from "./actionLog.js";

const baseEvent = (overrides: Partial<TimelineEvent>): TimelineEvent => ({
  authority: "dynamics",
  causes: [],
  eventId: "event:base",
  payload: {},
  recordedAt: "2026-08-01T00:00:00.000Z",
  seq: 1,
  streamId: "causal:main",
  subjects: [],
  t: 0,
  type: "dynamics.action.queued",
  viewClass: "other",
  ...overrides,
});

const declaration = ({
  actId,
  sequence,
  t,
  tick,
  participant,
  actor,
  action,
  target,
  provenance,
}: {
  actId: string;
  sequence: number;
  t: number;
  tick: number;
  participant: string;
  actor: string;
  action: string;
  target?: string;
  provenance?: string;
}): TimelineEvent[] => [
  baseEvent({
    eventId: `event:queued:${actId}`,
    seq: t + 1,
    t,
    payload: {
      attempt: {
        act_id: actId,
        action,
        actor,
        at_tick: tick,
        input: {},
        principal_id: participant,
        ...(target ? { target } : {}),
      },
      ...(provenance === undefined ? {} : { provenance }),
      receipt: { act_id: actId, apply_tick: tick, queued: true, sequence },
    },
  }),
  baseEvent({
    eventId: `event:applied:${actId}`,
    seq: t + 2,
    t: t + 1,
    type: "dynamics.action.applied",
    payload: {
      accepted: true,
      act_id: actId,
      action,
      actor,
      apply_tick: tick,
      principal_id: participant,
      ...(provenance === undefined ? {} : { provenance }),
      sequence,
      ...(target ? { target } : {}),
    },
  }),
];

const resolution = ({
  commitmentId,
  sequence,
  t,
  tick,
  outcome,
  participant,
  counterparty,
}: {
  commitmentId: string;
  sequence: number;
  t: number;
  tick: number;
  outcome: string;
  participant: string;
  counterparty?: string;
}): TimelineEvent =>
  baseEvent({
    eventId: `event:outcome:${commitmentId}`,
    seq: t + 1,
    t,
    type: "dynamics.commitment.outcome",
    payload: {
      commitment_id: commitmentId,
      ...(counterparty ? { counterparty } : {}),
      declaration_action_sequence: sequence,
      outcome,
      participant,
      provenance: "mechanical",
      tick,
    },
  });

const timeline = (events: TimelineEvent[]): RunTimeline => ({
  elements: [],
  events,
  runId: "run:log",
  version: "simfile.run-timeline.v1",
});

const run = timeline([
  ...declaration({
    actId: "act:early",
    action: "commit",
    actor: "object:participant.alpha",
    participant: "controller:alpha-mind",
    provenance: "external",
    sequence: 3,
    t: 0,
    target: "object:participant.beta",
    tick: 20,
  }),
  ...declaration({
    actId: "act:middle",
    action: "signal",
    actor: "object:participant.beta",
    participant: "controller:beta-mind",
    sequence: 9,
    t: 10,
    tick: 60,
  }),
  resolution({
    commitmentId: "commitment:alpha:3",
    counterparty: "object:participant.beta",
    outcome: "matched",
    participant: "object:participant.alpha",
    sequence: 3,
    t: 40,
    tick: 120,
  }),
]);

describe("buildActionLog", () => {
  it("orders every recorded entry by tick, then the run's own ordering key", () => {
    const log = buildActionLog(run);
    assert.deepEqual(
      log.entries.map(({ tick, phase, verb }) => `${tick}:${phase}:${verb}`),
      ["20:action:commit", "60:action:signal", "120:commitment:commit"],
    );
    assert.deepEqual(log.ticks, [20, 60, 120]);
  });

  it("does not change when the cursor does — one build serves every cursor", () => {
    const first = buildActionLog(run);
    const second = buildActionLog(run);
    assert.deepEqual(first.entries, second.entries);
  });

  it("holds root event provenance verbatim and gives a result precedence", () => {
    const events = declaration({
      actId: "act:provenance",
      action: "declare",
      actor: "object:provenance",
      participant: "principal:provenance",
      sequence: 1,
      t: 0,
      tick: 7,
    });
    const attemptPayload = events[0]!.payload as Record<string, unknown>;
    attemptPayload.provenance = "attempt-verbatim";
    assert.equal(
      buildActionLog(timeline([events[0]!])).entries[0]?.provenance,
      "attempt-verbatim",
    );
    const resultPayload = events[1]!.payload as Record<string, unknown>;
    resultPayload.provenance = "result-verbatim";
    assert.equal(
      buildActionLog(timeline(events)).entries[0]?.provenance,
      "result-verbatim",
    );
  });
});

describe("actionLogUpToTick", () => {
  it("accumulates every entry at or before the cursor, newest last", () => {
    const log = buildActionLog(run);
    assert.deepEqual(actionLogUpToTick(log, 19).map(({ tick }) => tick), []);
    assert.deepEqual(actionLogUpToTick(log, 20).map(({ tick }) => tick), [20]);
    // The tick-20 declaration is still readable 39 ticks later: this is the
    // append behaviour, not a one-frame flash at its own tick.
    assert.deepEqual(actionLogUpToTick(log, 59).map(({ tick }) => tick), [20]);
    assert.deepEqual(actionLogUpToTick(log, 119).map(({ tick }) => tick), [20, 60]);
    assert.deepEqual(
      actionLogUpToTick(log, 2000).map(({ tick }) => tick),
      [20, 60, 120],
    );
  });

  it("truncates when the cursor scrubs backwards", () => {
    const log = buildActionLog(run);
    assert.equal(actionLogUpToTick(log, 500).length, 3);
    assert.equal(actionLogUpToTick(log, 30).length, 1);
    assert.equal(actionLogUpToTick(log, 0).length, 0);
  });

  it("renders nothing for a cursor the run states no tick for", () => {
    assert.deepEqual(actionLogUpToTick(buildActionLog(run), undefined), []);
  });

  it("never mutates the built log", () => {
    const log = buildActionLog(run);
    const prefix = actionLogUpToTick(log, 60);
    assert.equal(prefix.length, 2);
    assert.equal(log.entries.length, 3);
  });
});

describe("a resolution carries its declaration", () => {
  it("names the declarer, counterparty, verb and declaring tick", () => {
    const entries = actionLogUpToTick(buildActionLog(run), 120);
    const [resolved] = entries
      .filter(({ phase }) => phase === "commitment");
    assert.deepEqual(resolved?.declaration, {
      actor: "object:participant.alpha",
      eventId: "event:queued:act:early",
      participant: "controller:alpha-mind",
      t: 0,
      target: "object:participant.beta",
      tick: 20,
      input: {},
      provenance: "external",
      verb: "commit",
    });
    assert.equal(
      entries.find(({ actId, phase }) =>
        actId === "act:early" && phase === "action")?.provenance,
      "external",
    );
    assert.equal(resolved?.provenance, "mechanical");
    assert.equal(resolved?.counterparty, "object:participant.beta");
    assert.equal(resolved?.outcome, "matched");
    // ...and it points back at a tick the log itself still shows.
    assert.ok(
      actionLogUpToTick(buildActionLog(run), 120)
        .some(({ tick, phase }) => tick === resolved?.declaration?.tick
          && phase === "action"),
    );
  });

  it("drops a terminal fact whose declaration the run never recorded", () => {
    const orphaned = timeline([
      resolution({
        commitmentId: "commitment:ghost",
        outcome: "expired",
        participant: "object:participant.alpha",
        sequence: 404,
        t: 3,
        tick: 12,
      }),
    ]);
    assert.deepEqual(buildActionLog(orphaned).entries, []);
  });

  it("carries declaration input, explicit validity and a mechanics message", () => {
    const input = {
      destination: { x: 1.234, y: -4.567 },
      mode: "survey",
      valid_for_ticks: 12,
    };
    const events = declaration({
      actId: "act:enriched",
      action: "commit",
      actor: "object:participant.alpha",
      participant: "controller:alpha-mind",
      sequence: 17,
      t: 0,
      tick: 5,
    });
    const queued = events[0]!;
    const applied = events[1]!;
    (queued.payload as { attempt: { input: unknown } }).attempt.input = input;
    (applied.payload as Record<string, unknown>).message = "ready";
    events.push(resolution({
      commitmentId: "commitment:enriched",
      outcome: "fulfilled",
      participant: "object:participant.alpha",
      sequence: 17,
      t: 4,
      tick: 9,
    }));

    const [action, terminal] = buildActionLog(timeline(events)).entries;
    assert.equal(action?.input, input);
    assert.equal(action?.cause, "ready");
    assert.equal(action?.validUntilTick, 17);
    assert.equal(terminal?.declaration?.input, input);
    assert.equal(terminal?.declaration?.validUntilTick, 17);
  });

  it("carries an ingress receipt code as cause without confusing it with detail", () => {
    const code = "ingress_denial_b259_unique_91f2c8";
    const rejected = baseEvent({
      eventId: "event:ingress:unique",
      payload: {
        attempt: {
          act_id: "act:ingress:unique",
          action: "signal",
          actor: "object:participant.alpha",
          at_tick: 7,
          input: { channel: "side" },
          principal_id: "controller:alpha-mind",
        },
        receipt: {
          act_id: "act:ingress:unique",
          apply_tick: 7,
          code,
          queued: false,
          sequence: 23,
        },
      },
      t: 3,
      type: "dynamics.action.rejected_at_ingress",
    });

    const [entry] = buildActionLog(timeline([rejected])).entries;
    assert.equal(entry?.outcome, "rejected");
    assert.equal(entry?.detail, "at ingress");
    assert.equal(entry?.cause, code);
  });
});

describe("actionLogAtTick", () => {
  it("slices only the entries recorded at that exact tick", () => {
    const log = buildActionLog(run);
    assert.deepEqual(actionLogAtTick(log, 60).map(({ verb }) => verb), ["signal"]);
    assert.deepEqual(actionLogAtTick(log, 61), []);
    assert.deepEqual(actionLogAtTick(log, undefined), []);
  });
});

describe("the log stays a prefix under a big run", () => {
  it("answers a cursor without rescanning: every prefix is a slice of one build", () => {
    const events: TimelineEvent[] = [];
    for (let index = 0; index < 400; index += 1) {
      events.push(...declaration({
        actId: `act:${index}`,
        action: "commit",
        actor: `object:participant.${index % 4}`,
        participant: `controller:mind-${index % 4}`,
        sequence: index + 1,
        t: index * 2,
        tick: index * 5,
      }));
    }
    const log = buildActionLog(timeline(events));
    assert.equal(log.entries.length, 400);
    for (const cursor of [0, 5, 500, 1000, 1995, 4000]) {
      const prefix = actionLogUpToTick(log, cursor);
      assert.deepEqual(
        prefix,
        log.entries.filter(({ tick }) => tick <= cursor),
      );
    }
  });
});
