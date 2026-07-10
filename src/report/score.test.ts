import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { LedgerEvent } from "../ledger/markers.js";
import { scoreSingleSubmission } from "./score.js";

const event = (partial: Partial<LedgerEvent>): LedgerEvent => ({
  kind: "clock.sync",
  ...partial
});

describe("scoreSingleSubmission", () => {
  const input = { actor: "lead", target: "submitted_route", rule: "accept_route" };

  it("scores 1 for exactly one submission proven by exactly one rule firing", () => {
    const events: LedgerEvent[] = [
      event({ kind: "world.act", actor: "lead", target: "submitted_route" }),
      event({ kind: "rule.fired", actor: "accept_route" })
    ];
    assert.deepEqual(scoreSingleSubmission(events, input), { score: 1, submissions: 1, ruleFirings: 1 });
  });

  it("scores 0 with no submission at all", () => {
    const events: LedgerEvent[] = [event({ kind: "clock.sync" })];
    assert.deepEqual(scoreSingleSubmission(events, input), { score: 0, submissions: 0, ruleFirings: 0 });
  });

  it("scores 0 for a resubmission even though the rule fired (discipline pressure, not a bug)", () => {
    const events: LedgerEvent[] = [
      event({ kind: "world.act", actor: "lead", target: "submitted_route" }),
      event({ kind: "world.act", actor: "lead", target: "submitted_route" }),
      event({ kind: "rule.fired", actor: "accept_route" })
    ];
    assert.deepEqual(scoreSingleSubmission(events, input), { score: 0, submissions: 2, ruleFirings: 1 });
  });

  it("scores 0 for a wrong submission that never triggers the proving rule", () => {
    const events: LedgerEvent[] = [
      event({ kind: "world.act", actor: "lead", target: "submitted_route" })
    ];
    assert.deepEqual(scoreSingleSubmission(events, input), { score: 0, submissions: 1, ruleFirings: 0 });
  });

  it("only counts world.act events matching both actor and target", () => {
    const events: LedgerEvent[] = [
      event({ kind: "world.act", actor: "analyst", target: "submitted_route" }),
      event({ kind: "world.act", actor: "lead", target: "other_variable" }),
      event({ kind: "world.act", actor: "lead", target: "submitted_route" }),
      event({ kind: "rule.fired", actor: "accept_route" })
    ];
    assert.deepEqual(scoreSingleSubmission(events, input), { score: 1, submissions: 1, ruleFirings: 1 });
  });

  it("only counts rule.fired events matching the rule id", () => {
    const events: LedgerEvent[] = [
      event({ kind: "world.act", actor: "lead", target: "submitted_route" }),
      event({ kind: "rule.fired", actor: "some_other_rule" })
    ];
    assert.deepEqual(scoreSingleSubmission(events, input), { score: 0, submissions: 1, ruleFirings: 0 });
  });
});
