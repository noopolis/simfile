import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { buildRunTimeline } from "./runTimeline.js";
import { buildRunWorldTrace, NO_PLACE_CAPTION } from "./runWorldTrace.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REAL_RUN_DIR = path.resolve(
  here,
  "..",
  "..",
  "runs",
  "real-grok-composed",
  "run-b7ef07f0fd2c4779894c2bb746140972",
);

describe("buildRunWorldTrace", () => {
  it("adapts the real run's timeline into a single informational room anchor with heuristic agents", async () => {
    const timeline = await buildRunTimeline(REAL_RUN_DIR);
    const trace = buildRunWorldTrace({
      runId: timeline.runId,
      runName: timeline.runId,
      world: { networkId: "office_lab", roomId: "office-room", members: ["eleanor", "sam"] },
      timeline,
    });

    assert.equal(trace.version, "viewer.trace.v1");
    assert.equal(trace.rooms.length, 1);
    assert.equal(trace.rooms[0]!.id, "office-room");
    assert.equal(trace.rooms[0]!.access_hint, NO_PLACE_CAPTION);
    assert.deepEqual(trace.rooms[0]!.members.slice().sort(), ["eleanor", "sam"]);

    assert.equal(trace.agents.length, 2);
    assert.ok(trace.agents.every((agent) => agent.label_hint === "heuristic"));

    assert.equal(trace.presence.length, 0);
    assert.equal(trace.corridors.length, 0);
    assert.equal(trace.ledger_facts.length, timeline.events.length);
    assert.equal(trace.ledger_facts[0]!.tick, 0);
    assert.ok(trace.ledger_facts.every((fact, index) => fact.tick === index));
  });
});
