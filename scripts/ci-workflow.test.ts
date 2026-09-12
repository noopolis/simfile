import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type WorkflowStep = Readonly<{ name?: string; run?: string }>;
type WorkflowJob = Readonly<{ steps?: readonly WorkflowStep[] }>;
type Workflow = Readonly<{ jobs?: Record<string, WorkflowJob> }>;

const workflowPath = ".github/workflows/test.yml";

const readWorkflow = async (): Promise<Workflow> => parse(await readFile(workflowPath, "utf8")) as Workflow;

test("CI jobs call the built test runner", async () => {
  const workflow = await readWorkflow();
  const jobs = workflow.jobs ?? {};
  const runs = Object.values(jobs).flatMap((job) => job.steps ?? [])
    .map((step) => step.run ?? "")
    .filter((run) => run.includes("run-tests"));

  assert.equal(runs.length, 2);
  assert.equal(runs.every((run) => run.includes("node dist/scripts/run-tests.js")), true);
  assert.equal(runs.some((run) => /find\s+src\s+web\/src\s+scripts\s+-name\s+'\*\.test\.ts'/.test(run)), true);
  assert.equal(runs.some((run) => run.includes("scripts/run-tests.mjs")), false);
});
