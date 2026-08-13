import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertRecordsByteIdentical,
  captureCli,
  createActionSourceProject,
  readJson,
  readJsonl
} from "./action-source.test-helper.js";
import { ensurePublicPackageBuild } from "../publicPackageBuild.test-helper.js";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const packagedCli = path.join(packageRoot, "dist", "cli", "index.js");

test("packaged CLI applies participant actions for 40 ticks", async (t) => {
  await ensurePublicPackageBuild(packageRoot);
  const project = await createActionSourceProject(t, {
    actionsEveryTick: ["move:red", "move:blue"],
    providerEventCausesAction: true
  });
  const left = path.join(project.root, "packaged-left");
  const right = path.join(project.root, "packaged-right");
  for (const out of [left, right]) {
    const result = await captureCli(
      project.args({
        out,
        runId: "packaged-action-source",
        ticks: 40
      }),
      packagedCli
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(
      result.stdout,
      `wrote run packaged-action-source to ${out}\n`
    );
    const actions = await readJsonl<any>(
      project.file("raw/action-results.jsonl", out),
      "nonempty"
    );
    assert.deepEqual(
      actions.map(({ result }) => [
        result.apply_tick,
        result.sequence,
        result.origin,
        result.accepted
      ]),
      Array.from({ length: 40 }, (_, tick) => [
        [tick, tick * 2 + 1, "controller", true],
        [tick, tick * 2 + 2, "controller", true]
      ]).flat()
    );
    assert.equal(
      (await readJson<any>(project.file("summary.json", out)))
        .decision_source.kind,
      "controller"
    );
  }
  await assertRecordsByteIdentical(left, right);
  const observed = await captureCli(["observe", left, "--json"], packagedCli);
  assert.equal(observed.code, 0, observed.stderr);
  const parsed = JSON.parse(observed.stdout) as any;
  assert.deepEqual(parsed.causalParseErrors, []);
  assert.deepEqual(parsed.report.chains.incomplete, []);
  assert.deepEqual(parsed.report.failures, []);
});
