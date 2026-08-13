import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OBSERVE_REPORT_VERSION, type SimfileObserveReport } from "./report.js";
import { observeSummaryLines } from "./summaryLines.js";

const baseReport: SimfileObserveReport = {
  version: OBSERVE_REPORT_VERSION,
  run_id: "summary-lines",
  contract_versions: {},
  participants: ["alpha", "beta"],
  agent_turns: {
    count: 2,
    sequence: ["alpha", "beta"]
  },
  chains: {
    complete: 3,
    incomplete: []
  },
  memory: [],
  failures: []
};

const commonLines = [
  "wrote observe report for run summary-lines to /runs/summary-lines/observe/report.json",
  "participants: alpha, beta",
  "agent turns: 2 (alpha -> beta)",
  "chains: 3 complete, 0 incomplete",
  "failures: 0"
];

describe("observeSummaryLines", () => {
  it("renders a missing grant marker as not recorded", () => {
    assert.deepEqual(
      observeSummaryLines(baseReport, "/runs/summary-lines/observe/report.json"),
      [
        ...commonLines,
        "world grants: not recorded"
      ]
    );
  });

  it("renders none-declared with no participants", () => {
    assert.deepEqual(
      observeSummaryLines({
        ...baseReport,
        world_grants: {
          status: "none-declared",
          participants: [],
          resolved: false,
          observed: false,
          deferred_to: "B158"
        }
      }, "/runs/summary-lines/observe/report.json"),
      [
        ...commonLines,
        "world grants: none-declared (resolved=false, observed=false, participants: none)"
      ]
    );
  });

  it("renders a declared status with its participant list", () => {
    assert.deepEqual(
      observeSummaryLines({
        ...baseReport,
        world_grants: {
          status: "declared-resolved",
          participants: ["alpha", "beta"],
          resolved: true,
          observed: true
        }
      }, "/runs/summary-lines/observe/report.json"),
      [
        ...commonLines,
        "world grants: declared-resolved (resolved=true, observed=true, participants: alpha, beta)"
      ]
    );
  });
});
