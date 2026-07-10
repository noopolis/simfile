import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parseCanonicalLedgerJsonl } from "../ledger/validation.js";
import { scoreSingleSubmission } from "../report/score.js";
import type { ProbeEvaluationResult } from "../report/probes.js";
import { parseSimfileSource } from "../schema/parse.js";
import { runCli } from "../cli/index.js";
import { writeRunRecord, type RunRecordResult } from "./run-record.js";
import type { QueuedWorldAct } from "./types.js";

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "e2e",
  "incident-routing-v0",
  "Simfile"
);

const SCORE_INPUT = { actor: "lead", target: "submitted_route", rule: "accept_route" };

const readFixture = async () => {
  const sourceText = await readFile(FIXTURE_PATH, "utf8");
  const { simfile, warnings } = parseSimfileSource(sourceText, { path: FIXTURE_PATH });
  assert.deepEqual(warnings, []);
  return { sourceText, simfile };
};

const runScenario = async (
  runId: string,
  seed: string,
  worldActs: QueuedWorldAct[],
  ticks = 8
): Promise<{ record: RunRecordResult; ledgerEvents: ReturnType<typeof parseCanonicalLedgerJsonl>; score: ReturnType<typeof scoreSingleSubmission> }> => {
  const { sourceText, simfile } = await readFixture();
  const dir = await mkdtemp(path.join(tmpdir(), "simfile-incident-routing-"));
  const outDir = path.join(dir, runId);
  const record = await writeRunRecord({
    outDir,
    runId,
    seed,
    simfile,
    sourcePath: FIXTURE_PATH,
    sourceText,
    ticks,
    worldActs
  });

  const ledgerText = await readFile(record.ledgerPath, "utf8");
  const ledgerEvents = parseCanonicalLedgerJsonl(ledgerText, { runId });
  const score = scoreSingleSubmission(ledgerEvents, SCORE_INPUT);

  return { record, ledgerEvents, score };
};

const probe = (probes: ProbeEvaluationResult[], probeId: string): ProbeEvaluationResult | undefined =>
  probes.find((entry) => entry.probeId === probeId);

const submitAct = (overrides: Partial<QueuedWorldAct> = {}): QueuedWorldAct => ({
  at_tick: 3,
  act_id: "a1",
  action: "variable:set",
  variable: "submitted_route",
  value: 2,
  actor: "lead",
  principal_id: "driver:lead",
  cause_event_ids: ["driver:turn:1"],
  ...overrides
});

describe("incident-routing-v0 (scored single-submission task, B58 world.act)", () => {
  it("C1: correct submission during work scores 1, with all three probes passing", async () => {
    const { record, ledgerEvents, score } = await runScenario("c1", "incident-routing-b58", [submitAct()]);

    assert.equal(record.trace.variables.task_score, 1);
    assert.equal(probe(record.report.probes, "submitted")?.passed, true);
    assert.equal(probe(record.report.probes, "no_resubmission")?.passed, true);
    assert.equal(probe(record.report.probes, "correct_before_close")?.passed, true);
    assert.deepEqual(score, { score: 1, submissions: 1, ruleFirings: 1 });

    const worldActEvents = ledgerEvents.filter((event) => event.kind === "world.act");
    assert.equal(worldActEvents.length, 1);
    assert.equal(worldActEvents[0]?.provenance, "agentic");
    const acceptFirings = ledgerEvents.filter((event) => event.kind === "rule.fired" && event.actor === "accept_route");
    assert.equal(acceptFirings.length, 1);

    assert.deepEqual(record.report.world_acts, [
      { accepted: true, act_id: "a1", apply_tick: 3, event_id: worldActEvents[0]?.event_id }
    ]);
  });

  it("C2: a wrong route never proves correct_before_close and scores 0", async () => {
    const { record, score } = await runScenario("c2", "incident-routing-b58", [submitAct({ value: 3 })]);

    assert.equal(record.trace.variables.task_score, 0);
    assert.equal(probe(record.report.probes, "submitted")?.passed, true);
    assert.equal(probe(record.report.probes, "correct_before_close")?.passed, false);
    assert.deepEqual(score, { score: 0, submissions: 1, ruleFirings: 0 });
  });

  it("C3: a resubmission (distinct act_ids) fails no_resubmission and scores 0 even though the rule fired", async () => {
    const { record, score } = await runScenario("c3", "incident-routing-b58", [
      submitAct({ at_tick: 2, act_id: "s1", value: 3 }),
      submitAct({ at_tick: 3, act_id: "s2", value: 2 })
    ]);

    assert.equal(probe(record.report.probes, "no_resubmission")?.passed, false);
    assert.equal(probe(record.report.probes, "correct_before_close")?.passed, true);
    assert.deepEqual(score, { score: 0, submissions: 2, ruleFirings: 1 });
  });

  it("C4: no submission at all scores 0 and fails the submitted probe", async () => {
    const { record, score } = await runScenario("c4", "incident-routing-b58", []);

    assert.equal(probe(record.report.probes, "submitted")?.passed, false);
    assert.deepEqual(score, { score: 0, submissions: 0, ruleFirings: 0 });
  });

  it("C5: a correct submission after the work phase closes is ACCEPTED (not run_closed) but never proves the rule, scoring 0", async () => {
    const { record, score } = await runScenario("c5", "incident-routing-b58", [submitAct({ at_tick: 6 })]);

    assert.equal(record.report.world_acts[0]?.accepted, true);
    assert.notEqual(record.report.world_acts[0]?.code, "run_closed");
    assert.equal(probe(record.report.probes, "correct_before_close")?.passed, false);
    assert.deepEqual(score, { score: 0, submissions: 1, ruleFirings: 0 });
  });

  it("C6: a second seed with a different hidden expected_route also scores 1", async () => {
    // seed "incident-routing-b58-alt-1" draws impact=0, exposure=1 -> expected_route=3.
    const { record, score } = await runScenario("c6", "incident-routing-b58-alt-1", [submitAct({ value: 3 })]);

    assert.equal(record.trace.variables.expected_route, 3);
    assert.equal(record.trace.variables.task_score, 1);
    assert.deepEqual(score, { score: 1, submissions: 1, ruleFirings: 1 });
  });

  it("C7: the CLI --acts flag reproduces C1", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "simfile-incident-routing-cli-"));
    const actsPath = path.join(dir, "acts.json");
    const outDir = path.join(dir, "runs", "c7");
    await writeFile(actsPath, JSON.stringify([submitAct()]), "utf8");

    const code = await runCli([
      "run",
      FIXTURE_PATH,
      "--ticks", "8",
      "--seed", "incident-routing-b58",
      "--run-id", "c7",
      "--out", outDir,
      "--acts", actsPath
    ]);
    assert.equal(code, 0);

    const ledgerText = await readFile(path.join(outDir, "ledger.jsonl"), "utf8");
    const ledgerEvents = parseCanonicalLedgerJsonl(ledgerText, { runId: "c7" });
    const worldActEvents = ledgerEvents.filter((event) => event.kind === "world.act");
    const acceptFirings = ledgerEvents.filter((event) => event.kind === "rule.fired" && event.actor === "accept_route");
    assert.equal(worldActEvents.length, 1);
    assert.equal(acceptFirings.length, 1);

    const report = JSON.parse(await readFile(path.join(outDir, "report.json"), "utf8")) as {
      probes: ProbeEvaluationResult[];
    };
    assert.equal(probe(report.probes, "submitted")?.passed, true);
    assert.equal(probe(report.probes, "no_resubmission")?.passed, true);
    assert.equal(probe(report.probes, "correct_before_close")?.passed, true);

    const score = scoreSingleSubmission(ledgerEvents, SCORE_INPUT);
    assert.deepEqual(score, { score: 1, submissions: 1, ruleFirings: 1 });
  });
});
