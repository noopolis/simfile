import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  assertRecordsByteIdentical,
  captureCli,
  createActionSourceProject,
  NONE_DECISION_SOURCE,
  readJson,
  readJsonl,
  SCRIPTED_SOURCE
} from "./action-source.test-helper.js";

test("A1 no source preserves the B157 dynamics record", async (t) => {
  const project = await createActionSourceProject(t, { source: "absent" });
  const result = await captureCli(project.args({ ticks: 4 }));
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.equal(
    result.stdout,
    `wrote run action-source-run to ${project.out}\n`
  );
  const provenance = await readJson<any>(project.file("provenance.json"));
  const summary = await readJson<any>(project.file("summary.json"));
  const replay = await readJson<any>(
    project.file("replay/action-stream.json")
  );
  assert.equal(provenance.action_source, "none");
  assert.deepEqual(provenance.decision_source, NONE_DECISION_SOURCE);
  assert.deepEqual(summary.decision_source, NONE_DECISION_SOURCE);
  assert.deepEqual(replay.actions, []);
  assert.deepEqual(
    await readJsonl(project.file("raw/action-attempts.jsonl"), "empty"),
    []
  );
  assert.deepEqual(
    await readJsonl(project.file("raw/action-results.jsonl"), "empty"),
    []
  );
  assert.deepEqual(
    (await readJson<any>(project.file("manifest.json"))).world.decision_source,
    NONE_DECISION_SOURCE
  );
  const versions = (await readJson<any>(
    project.file("manifest.json")
  )).contract_versions;
  assert.equal("simfile.dynamics-run-action-source.v1" in versions, false);
});

test("A2 a declared silent source remains silence", async (t) => {
  const project = await createActionSourceProject(t, { source: "silent" });
  const result = await captureCli(project.args({ ticks: 5 }));
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const provenance = await readJson<any>(project.file("provenance.json"));
  const final = await readJson<any>(
    project.file("replay/final-session.json")
  );
  assert.equal(final.next_tick, 5);
  assert.deepEqual(provenance.action_source, SCRIPTED_SOURCE);
  assert.deepEqual(provenance.decision_source, NONE_DECISION_SOURCE);
  assert.deepEqual(
    await readJsonl(project.file("raw/action-attempts.jsonl"), "empty"),
    []
  );
  assert.deepEqual(
    await readJsonl(project.file("raw/action-results.jsonl"), "empty"),
    []
  );
  const versions = (await readJson<any>(
    project.file("manifest.json")
  )).contract_versions;
  for (const version of [
    "simfile.dynamics-run-action-source.v1",
    "simfile.dynamics-run-action-ingress.v1",
    "simfile.dynamics-run-action-result.v1"
  ]) assert.equal(versions[version], version);
});

test("A3 zero, one, and many are distinguished by exact vectors", async (t) => {
  for (const [name, actions] of [
    ["zero", []],
    ["one", ["move:red"]],
    ["many", ["move:red", "kick:blue", "move:blue"]]
  ] as const) {
    await t.test(name, async (subtest) => {
      const project = await createActionSourceProject(subtest, {
        actionsAtTickZero: actions
      });
      const result = await captureCli(project.args({ ticks: 2 }));
      assert.equal(result.code, 0, `${name}: ${result.stderr}`);
      assert.equal(result.stderr, "", name);
      const attempts = await readJsonl<any>(
        project.file("raw/action-attempts.jsonl"),
        actions.length === 0 ? "empty" : "nonempty"
      );
      const results = await readJsonl<any>(
        project.file("raw/action-results.jsonl"),
        actions.length === 0 ? "empty" : "nonempty"
      );
      assert.deepEqual(
        attempts.map((entry) => entry.attempt.action),
        actions
      );
      assert.deepEqual(
        attempts.map((entry) => entry.receipt.sequence),
        actions.map((_, index) => index + 1)
      );
      assert.deepEqual(
        results.map((entry) => entry.result.action),
        actions
      );
      assert.deepEqual(
        results.map((entry) => entry.result.sequence),
        actions.map((_, index) => index + 1)
      );
      assert.deepEqual(
        results.map((entry) => entry.result.origin),
        actions.map(() => "controller")
      );
      const summary = await readJson<any>(project.file("summary.json"));
      assert.equal(
        summary.decision_source.kind,
        actions.length === 0 ? "none" : "controller"
      );
    });
  }
});

test("A4 a hanging participant return never gates the clock", {
  timeout: 60_000
}, async (t) => {
  const project = await createActionSourceProject(t, {
    source: "returns-never-settling-promise"
  });
  const result = await captureCli(project.args({ ticks: 40 }));
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const final = await readJson<any>(
    project.file("replay/final-session.json")
  );
  const steps = await readJsonl<any>(
    project.file("raw/steps.jsonl"),
    "nonempty"
  );
  assert.equal(final.next_tick, 40);
  assert.deepEqual(
    steps.map((step) => [step.from_tick, step.to_tick]),
    Array.from({ length: 40 }, (_, tick) => [tick, tick + 1])
  );
  assert.deepEqual(
    await readJsonl(project.file("raw/action-results.jsonl"), "empty"),
    []
  );
});

test("A5 sync submission followed by a hanging return still applies", {
  timeout: 60_000
}, async (t) => {
  const project = await createActionSourceProject(t, {
    source: "queues-one-then-returns-never"
  });
  const result = await captureCli(project.args({ ticks: 3 }));
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const results = await readJsonl<any>(
    project.file("raw/action-results.jsonl"),
    "nonempty"
  );
  assert.deepEqual(
    results.map(({ result }) => [
      result.apply_tick,
      result.sequence,
      result.origin,
      result.accepted
    ]),
    [[0, 1, "controller", true]]
  );
  assert.equal(
    (await readJson<any>(project.file("summary.json"))).final_tick,
    3
  );
});

test("A6 two action-bearing runs are byte-identical", async (t) => {
  const project = await createActionSourceProject(t, {
    actionsEveryTick: ["move:red", "move:blue"]
  });
  const left = path.join(project.root, "left");
  const right = path.join(project.root, "right");
  const [leftResult, rightResult] = await Promise.all([
    captureCli(project.args({
      out: left,
      runId: "action-source-double",
      ticks: 40
    })),
    captureCli(project.args({
      out: right,
      runId: "action-source-double",
      ticks: 40
    }))
  ]);
  assert.equal(leftResult.code, 0);
  assert.equal(rightResult.code, 0);
  assert.equal(leftResult.stderr, "");
  assert.equal(rightResult.stderr, "");
  const leftResults = await readJsonl<any>(
    project.file("raw/action-results.jsonl", left),
    "nonempty"
  );
  const rightResults = await readJsonl<any>(
    project.file("raw/action-results.jsonl", right),
    "nonempty"
  );
  assert.deepEqual(
    leftResults.map(({ result }) => result.origin),
    Array.from({ length: 80 }, () => "controller")
  );
  assert.deepEqual(rightResults, leftResults);
  assert.equal(
    (await readJson<any>(project.file("summary.json", left)))
      .decision_source.kind,
    "controller"
  );
  await assertRecordsByteIdentical(left, right);
});

test("A7 action causes are exact and observe consumes the record", async (t) => {
  const project = await createActionSourceProject(t, {
    actionsAtTickZero: ["move:red"],
    providerEventCausesAction: true
  });
  assert.equal((await captureCli(project.args({ ticks: 2 }))).code, 0);
  const ledger = await readJsonl<any>(
    project.file("raw/world/causal.jsonl"),
    "nonempty"
  );
  const ingress = ledger.find((event) =>
    event.type === "dynamics.action.queued");
  const result = ledger.find((event) =>
    event.type === "dynamics.action.applied");
  const step = ledger.find((event) => event.type === "dynamics.step"
    && event.payload.from_tick === 0);
  const effect = ledger.find((event) => event.type === "counter.moved");
  assert.ok(ingress && result && step && effect);
  assert.deepEqual(result.cause_event_ids, [ingress.event_id]);
  assert.deepEqual(step.cause_event_ids.slice(1), [result.event_id]);
  assert.deepEqual(
    effect.cause_event_ids,
    [step.event_id, result.event_id]
  );
  const observed = await captureCli(["observe", project.out, "--json"]);
  assert.equal(observed.code, 0);
  assert.equal(observed.stderr, "");
  const parsed = JSON.parse(observed.stdout) as any;
  assert.deepEqual(parsed.causalParseErrors, []);
  assert.equal(
    parsed.artifactIntegrity.every((entry: any) => entry.ok === true),
    true
  );
  assert.deepEqual(parsed.report.chains.incomplete, []);
  assert.deepEqual(parsed.report.failures, []);
  assert.equal(
    parsed.report.run_id,
    (await readJson<any>(project.file("summary.json"))).run_id
  );
  await readFile(project.file("observe/report.json"));
});

test("H4 source cannot claim live provenance", async (t) => {
  const project = await createActionSourceProject(t, {
    declarationPatch: { live_acceptance: true }
  });
  const result = await captureCli(project.args({ ticks: 1 }));
  assert.equal(result.code, 1);
  assert.equal(
    result.stderr,
    "dynamics run action source live_acceptance must be false\n"
  );
  assert.equal(result.stdout, "");
  await assert.rejects(access(project.out));
});

test("H5 source receives no raw session or action queue", async (t) => {
  const project = await createActionSourceProject(t, {
    source: "assert-context-exact-keys"
  });
  const result = await captureCli(project.args({ ticks: 1 }));
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
});

test("H6 late async action is rejected and never appears", async (t) => {
  const project = await createActionSourceProject(t, {
    source: "queue-after-await"
  });
  const result = await captureCli(project.args({ ticks: 3 }));
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(
    await readJsonl(project.file("raw/action-attempts.jsonl"), "empty"),
    []
  );
  assert.deepEqual(
    await readJsonl(project.file("raw/action-results.jsonl"), "empty"),
    []
  );
  assert.deepEqual(
    (await readJson<any>(project.file("summary.json"))).decision_source,
    NONE_DECISION_SOURCE
  );
});

test("H7 a synchronous source failure is not retried", async (t) => {
  const project = await createActionSourceProject(t, {
    source: "throw-with-call-counter"
  });
  const result = await captureCli(project.args({ ticks: 4 }));
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "injected source failure call 1\n");
  assert.equal(result.stdout, "");
  await assert.rejects(access(project.out));
});
