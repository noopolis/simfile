import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  actionFeedCategories,
  actionFeedCategoryCounts,
  actionFeedCategoryKey,
  filterActionFeedEntries,
} from "./actionFeedCategories.js";
import type { ActionLog, ActionLogEntry } from "./actionLog.js";

const entry = (
  overrides: Partial<ActionLogEntry> = {},
): ActionLogEntry => ({
  actId: "act:category",
  eventId: "event:category",
  outcome: "accepted",
  participant: "controller:category",
  phase: "action",
  provenance: "external",
  t: 1,
  tick: 1,
  verb: "inspect_state",
  ...overrides,
});

const entries: readonly ActionLogEntry[] = [
  entry(),
  entry({
    eventId: "event:derived",
    outcome: "fulfilled",
    phase: "commitment",
    provenance: "mechanical",
    t: 2,
    tick: 4,
    verb: "body-step",
  }),
  entry({
    eventId: "event:refused",
    outcome: "rejected",
    t: 3,
    tick: 5,
  }),
];

const log: ActionLog = {
  entries,
  ticks: entries.map(({ tick }) => tick),
};

describe("actionFeedCategories", () => {
  it("derives stable role-and-record-verb keys and humanized labels", () => {
    assert.deepEqual(actionFeedCategories(log), [
      {
        decider: "declared",
        key: "declared|inspect_state",
        label: "declared inspect state",
        verb: "inspect_state",
      },
      {
        decider: "derived",
        key: "derived|body-step",
        label: "derived body step",
        verb: "body-step",
      },
      {
        decider: "refused",
        key: "refused|inspect_state",
        label: "refused inspect state",
        verb: "inspect_state",
      },
    ]);
  });

  it("keeps whole-log categories while cursor-prefix counts can be zero", () => {
    const categories = actionFeedCategories(log);
    const counts = actionFeedCategoryCounts(entries.slice(0, 1));
    assert.equal(counts.get(categories[0]?.key ?? ""), 1);
    assert.equal(counts.get(categories[1]?.key ?? "") ?? 0, 0);
    assert.equal(counts.get(categories[2]?.key ?? "") ?? 0, 0);
  });

  it("filters only keys the reader hid", () => {
    const hidden = new Set([actionFeedCategoryKey(entries[1]!)]);
    const filtered = filterActionFeedEntries(entries, hidden);
    assert.deepEqual(filtered.map(({ eventId }) => eventId), [
      "event:category",
      "event:refused",
    ]);
    assert.equal(entries.length - filtered.length, 1);
  });
});
