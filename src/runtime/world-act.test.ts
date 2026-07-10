import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateCanonicalLedgerEvents } from "../ledger/validation.js";
import { parseSimfileSource } from "../schema/parse.js";
import { runSimfileTrace } from "./trace-run.js";
import { ingestWorldActs, validateWorldAct, WORLD_ACT_KIND } from "./world-act.js";
import type { QueuedWorldAct } from "./types.js";

const parse = (source: string) => parseSimfileSource(source, { path: "Simfile.yaml" }).simfile;

const worldActSimfile = parse(`
simfile_version: "0.1"
name: world-act-world
clock:
  seed: world-act
  tick: 1m
variables:
  fed_var:
    scope: room:office-floor:incident-desk
    initial: 0
    range: 0..10
    fed_by: lead
  doubled:
    scope: global
    range: 0..20
    derive:
      eq: fed_var * 2
rules:
  observe:
    fire: once
    when:
      event: world.act
      actor: lead
    do:
      - action: wake:recommend
        to: room:office-floor:case-warroom
`);

const act = (overrides: Partial<QueuedWorldAct> = {}): QueuedWorldAct => ({
  at_tick: 0,
  act_id: "act-1",
  action: "variable:set",
  variable: "fed_var",
  value: 5,
  actor: "lead",
  principal_id: "driver:lead",
  ...overrides
});

describe("validateWorldAct", () => {
  const baseCtx = () => ({
    ticks: 4,
    ranges: new Map([["fed_var", { min: 0, max: 10 }]]),
    variableFedBy: new Map([["fed_var", "lead"]]),
    seenActIds: new Set<string>()
  });

  it("accepts a well-formed, in-range, authorized act", () => {
    assert.equal(validateWorldAct(act(), baseCtx()), undefined);
  });

  it("rejects a repeated act_id as duplicate, regardless of first outcome", () => {
    const ctx = baseCtx();
    assert.equal(validateWorldAct(act({ value: 999 }), ctx), "out_of_range");
    assert.equal(validateWorldAct(act(), ctx), "duplicate");
  });

  it("rejects an act at or past the run's tick count as run_closed", () => {
    const ctx = baseCtx();
    assert.equal(validateWorldAct(act({ act_id: "closed-1", at_tick: 4 }), ctx), "run_closed");
  });

  it("rejects an act on an undeclared variable as unknown_variable", () => {
    const ctx = baseCtx();
    assert.equal(validateWorldAct(act({ act_id: "unk-1", variable: "nope" }), ctx), "unknown_variable");
  });

  it("rejects an act with no declared fed_by as not_authorized", () => {
    const ctx = {
      ticks: 4,
      ranges: new Map([["fed_var", { min: 0, max: 10 }]]),
      variableFedBy: new Map<string, string>(),
      seenActIds: new Set<string>()
    };
    assert.equal(validateWorldAct(act({ act_id: "auth-1" }), ctx), "not_authorized");
  });

  it("rejects an act whose actor does not match fed_by as not_authorized", () => {
    const ctx = baseCtx();
    assert.equal(validateWorldAct(act({ act_id: "auth-2", actor: "someone-else" }), ctx), "not_authorized");
  });

  it("rejects a non-finite value as not_finite", () => {
    const ctx = baseCtx();
    assert.equal(validateWorldAct(act({ act_id: "finite-1", value: Number.NaN }), ctx), "not_finite");
  });

  it("rejects an out-of-range value as out_of_range", () => {
    const ctx = baseCtx();
    assert.equal(validateWorldAct(act({ act_id: "range-1", value: 10.5 }), ctx), "out_of_range");
  });

  it("checks ingestion order: duplicate wins over every other rejection", () => {
    const ctx = baseCtx();
    assert.equal(validateWorldAct(act({ at_tick: 99, variable: "nope", actor: "x", value: Number.NaN }), ctx), "run_closed");
    // Same act_id retried: even though every other check would also fail, duplicate is reported.
    assert.equal(validateWorldAct(act({ at_tick: 99, variable: "nope", actor: "x", value: Number.NaN }), ctx), "duplicate");
  });
});

describe("ingestWorldActs", () => {
  const ctx = {
    ticks: 4,
    ranges: new Map([["fed_var", { min: 0, max: 10 }]]),
    variableFedBy: new Map([["fed_var", "lead"]])
  };

  it("throws a transport/schema error for an unsupported action before ingestion", () => {
    assert.throws(
      () => ingestWorldActs([act({ action: "movement" as unknown as "variable:set" })], ctx),
      /action must be variable:set/
    );
  });

  it("throws a transport/schema error for a non-numeric value before ingestion", () => {
    assert.throws(
      () => ingestWorldActs([act({ value: "2" as unknown as number })], ctx),
      /value must be numeric/
    );
  });

  it("throws for an empty or oversized act_id", () => {
    assert.throws(() => ingestWorldActs([act({ act_id: "" })], ctx), /act_id must be a non-empty string/);
    assert.throws(() => ingestWorldActs([act({ act_id: "x".repeat(129) })], ctx), /act_id must be a non-empty string/);
  });

  it("returns one WorldActResult per queued act, in submission order, dedup applying across the whole batch", () => {
    const acts = [act({ act_id: "a" }), act({ act_id: "a", value: 1 }), act({ act_id: "b", value: 20 })];
    const { results, queueByTick } = ingestWorldActs(acts, ctx);
    assert.deepEqual(results.map((result) => result.act_id), ["a", "a", "b"]);
    assert.equal(results[0]?.accepted, true);
    assert.equal(results[1]?.code, "duplicate");
    assert.equal(results[2]?.code, "out_of_range");
    assert.equal(queueByTick.get(0)?.length, 1);
  });
});

describe("world.act runtime application", () => {
  it("rejects out-of-range acts without clamping the variable or emitting an event", () => {
    const trace = runSimfileTrace(worldActSimfile, {
      runId: "reject-run",
      seed: "seed",
      ticks: 2,
      worldActs: [act({ value: 999 })]
    });
    assert.equal(trace.variables.fed_var, 0);
    assert.equal(trace.events.some((event) => event.kind === WORLD_ACT_KIND), false);
    assert.deepEqual(trace.actResults, [{ accepted: false, act_id: "act-1", code: "out_of_range" }]);
  });

  it("accepts an act on the run's last tick (ACCEPTED, not run_closed) as long as at_tick is inside the run", () => {
    const trace = runSimfileTrace(worldActSimfile, {
      runId: "closed-run",
      seed: "seed",
      ticks: 4,
      worldActs: [act({ at_tick: 3 })]
    });
    assert.equal(trace.actResults[0]?.accepted, true);
    assert.equal(trace.actResults[0]?.code, undefined);
  });

  it("rejects an act at or past the run's tick count as run_closed", () => {
    const trace = runSimfileTrace(worldActSimfile, {
      runId: "run-closed-run",
      seed: "seed",
      ticks: 4,
      worldActs: [act({ at_tick: 4 })]
    });
    assert.deepEqual(trace.actResults, [{ accepted: false, act_id: "act-1", code: "run_closed" }]);
  });

  it("applies an accepted act after clock.sync but before generators/derived/rules, same tick", () => {
    const trace = runSimfileTrace(worldActSimfile, {
      runId: "apply-run",
      seed: "seed",
      ticks: 2,
      worldActs: [act({ at_tick: 0 })]
    });

    assert.equal(trace.variables.fed_var, 5);
    assert.equal(trace.variables.doubled, 10, "derived variable must reflect the same-tick act");

    const worldAct = trace.events.find((event) => event.kind === WORLD_ACT_KIND);
    assert.ok(worldAct);
    assert.equal(worldAct?.sim_time, 0);

    const ruleFired = trace.events.find((event) => event.kind === "rule.fired" && event.actor === "observe");
    assert.ok(ruleFired, "same-tick event:world.act condition must let the rule fire in the same tick");
    assert.equal(ruleFired?.sim_time, 0);
  });

  it("mints a canonical envelope: kind world.act, provenance agentic, injected principal_id, preserved external cause_event_ids", () => {
    const trace = runSimfileTrace(worldActSimfile, {
      runId: "envelope-run",
      seed: "seed",
      ticks: 1,
      worldActs: [act({ principal_id: "driver:lead", cause_event_ids: ["driver:turn:7"] })]
    });

    const worldAct = trace.events.find((event) => event.kind === WORLD_ACT_KIND);
    assert.ok(worldAct);
    assert.equal(worldAct?.kind, WORLD_ACT_KIND);
    assert.equal(worldAct?.provenance, "agentic");
    assert.equal(worldAct?.principal_id, "driver:lead");
    assert.deepEqual(worldAct?.cause_event_ids, ["driver:turn:7"]);
    assert.equal(worldAct?.actor, "lead");
    assert.equal(worldAct?.target, "fed_var");
    assert.equal(worldAct?.scope, "room:office-floor:incident-desk");

    for (const key of ["sim_time", "provenance", "actor", "target", "scope", "act_id", "action", "value"]) {
      assert.equal(Object.hasOwn(worldAct!.payload as object, key), true, `missing world.act payload key ${key}`);
    }
    assert.deepEqual(Object.keys(worldAct!.payload as object).sort(), [
      "act_id", "action", "actor", "provenance", "scope", "sim_time", "target", "value"
    ].sort());

    // event_id/seq is contiguous on the shared world stream alongside every other event kind.
    assert.doesNotThrow(() => validateCanonicalLedgerEvents(trace.events, { runId: "envelope-run" }));
  });

  it("emits one event per accepted act on a shared var/tick; last write wins", () => {
    const trace = runSimfileTrace(worldActSimfile, {
      runId: "last-write-run",
      seed: "seed",
      ticks: 1,
      worldActs: [
        act({ act_id: "first", value: 3 }),
        act({ act_id: "second", value: 7 })
      ]
    });

    const worldActs = trace.events.filter((event) => event.kind === WORLD_ACT_KIND);
    assert.equal(worldActs.length, 2);
    assert.equal(trace.variables.fed_var, 7);
    assert.deepEqual(trace.actResults.map((result) => result.accepted), [true, true]);
  });

  it("is deterministic for identical queued acts", () => {
    const options = {
      runId: "det-run",
      seed: "seed",
      ticks: 2,
      worldActs: [act()]
    };
    const first = runSimfileTrace(worldActSimfile, options);
    const second = runSimfileTrace(worldActSimfile, options);
    assert.deepEqual(first.events, second.events);
    assert.deepEqual(first.actResults, second.actResults);
  });
});
