import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  inspectionAtTick,
  inspectionSnapshotAtTick,
} from "./inspectionModel.js";

describe("inspectionAtTick", () => {
  const samples = [
    { inspections: [{ fields: [{ label: "decision", value: "active" }], node_id: "red" }], tick: 10 },
    { inspections: [{ fields: [{ label: "decision", value: "consumed" }], node_id: "red" }], tick: 20 },
  ];

  it("selects the latest public inspector snapshot at the replay cursor", () => {
    assert.equal(inspectionAtTick(samples, 9, "red"), undefined);
    assert.equal(inspectionAtTick(samples, 10, "red")?.fields[0]?.value, "active");
    assert.equal(inspectionAtTick(samples, 19, "red")?.fields[0]?.value, "active");
    assert.equal(inspectionAtTick(samples, 20, "red")?.fields[0]?.value, "consumed");
  });

  it("retains stable public identity fields omitted by compact cursor samples", () => {
    const snapshot = inspectionSnapshotAtTick(samples, 10, "red", {
      fields: [
        { label: "team", value: "red" },
        { label: "decision", value: "consumed" },
      ],
      node_id: "red",
    });
    assert.deepEqual(snapshot?.fields, [
      { label: "team", value: "red" },
      { label: "decision", value: "active" },
    ]);
  });
});
