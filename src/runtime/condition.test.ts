import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { conditionVariableIds, type ConditionNode } from "./condition.js";

describe("conditionVariableIds", () => {
  it("returns the single variable id of a leaf variable condition", () => {
    const node: ConditionNode = { variable: "filing_pressure", above: 0.85 };
    assert.deepEqual(conditionVariableIds(node), ["filing_pressure"]);
  });

  it("returns [] for a phase condition (no variable referenced)", () => {
    const node: ConditionNode = { phase: "workday" };
    assert.deepEqual(conditionVariableIds(node), []);
  });

  it("returns [] for an event condition (no variable referenced)", () => {
    const node: ConditionNode = { event: "clock.sync" };
    assert.deepEqual(conditionVariableIds(node), []);
  });

  it("collects every distinct variable id across all/any/not, in first-seen order", () => {
    const node: ConditionNode = {
      all: [
        { variable: "mood", above: 5 },
        {
          any: [
            { variable: "energy", below: 2 },
            { not: { variable: "mood", above: 5 } },
          ],
        },
      ],
    };
    assert.deepEqual(conditionVariableIds(node), ["mood", "energy"]);
  });
});
