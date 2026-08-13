import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseSimfileSource } from "../schema/parse.js";
import { buildCausalFixtureRecords } from "./causal-fixture.js";
import { runSimfileTrace } from "./trace-run.js";

const CAUSAL_ENVELOPE_TOP_LEVEL_KEYS = [
  "version",
  "run_id",
  "event_id",
  "emitter",
  "type",
  "principal_id",
  "recorded_at",
  "cause_event_ids",
  "payload"
].sort();

const EVENT_ID_PATTERN = /^[^:]+:.+$/u;

describe("buildCausalFixtureRecords", () => {
  it("maps every trace event onto a schema-valid noopolis.causal-event.v1 record", () => {
    const simfile = parseSimfileSource(`
simfile_version: "0.1"
name: fixture-world
clock:
  seed: fixture
  tick: 1m
rules:
  announce:
    fire: once
    when:
      event: clock.sync
    do:
      - action: moltnet:message
        to: room:office-floor:case-warroom
        content: "fixture message"
      - action: moltnet:message
        to: room:office-floor:case-warroom
        content: "Observation notice."
`, { path: "Simfile.yaml" }).simfile;

    const trace = runSimfileTrace(simfile, { runId: "fixture-run", seed: "fixture-seed", ticks: 1 });
    const records = buildCausalFixtureRecords(trace.events);
    assert.equal(records.length, trace.events.length);

    for (const record of records) {
      assert.deepEqual(Object.keys(record).sort(), CAUSAL_ENVELOPE_TOP_LEVEL_KEYS);
      assert.equal(record.version, "noopolis.causal-event.v1");
      assert.equal(record.run_id, "fixture-run");
      assert.match(record.event_id, EVENT_ID_PATTERN);
      assert.equal(record.event_id.startsWith("simfile:"), true);
      assert.equal(record.emitter.system, "simfile");
      assert.equal(record.emitter.stream_id, "world");
      assert.equal(Number.isInteger(record.emitter.seq) && record.emitter.seq >= 1, true);
      assert.equal(typeof record.type, "string");
      assert.equal(record.principal_id, "system:simfile.world");
      assert.equal(Number.isNaN(Date.parse(record.recorded_at)), false);
      assert.equal(Array.isArray(record.cause_event_ids), true);
      assert.equal(typeof record.payload, "object");
    }

    const messageRecord = records.find((record) => record.type === "world.message");
    assert.ok(messageRecord);
    // world.act payload minimum: {sim_time, provenance, actor, target, scope, act_id, action, value}
    for (const key of ["sim_time", "provenance", "actor", "target", "scope", "act_id", "action", "value"]) {
      assert.equal(Object.hasOwn(messageRecord!.payload, key), true, `missing world.act payload key ${key}`);
    }
    assert.equal(messageRecord!.payload.action, "moltnet:message");

    const ruleFiredRecord = records.find((record) => record.type === "rule.fired");
    assert.ok(ruleFiredRecord);
    assert.deepEqual(ruleFiredRecord!.cause_event_ids, [records.find((record) => record.type === "clock.sync")!.event_id]);
    assert.deepEqual(messageRecord!.cause_event_ids, [ruleFiredRecord!.event_id]);
  });
});
