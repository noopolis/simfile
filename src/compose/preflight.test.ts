import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { DynamicsRunActionSourceDeclaration } from "../dynamics/runActionSource.js";
import { parseSimfileSource } from "../schema/parse.js";
import { lifecycleRequest } from "./lifecycle.test-helper.js";
import { runPreflightedComposedRun } from "./preflight.js";
import { createComposedRunHarness } from "./run.test-helper.js";

const source = (config = ""): string => `simfile_version: "0.1"
name: composed-preflight
spawnfile: ./Spawnfile
clock:
  seed: composed-preflight
  tick: 1s
dynamics:
  module: ./systems/world.ts
  config:${config || " {}"}
`;

const scriptedSource: DynamicsRunActionSourceDeclaration = Object.freeze({
  id: "local-script",
  live_acceptance: false,
  onTick: () => undefined,
  participants: Object.freeze(["red"]),
  provenance: "scripted",
  version: "simfile.dynamics-run-action-source.v1",
});

test("composed preflight rejects every scripted input before owner or journal mutation", async () => {
  const safe = parseSimfileSource(source(), { path: "Simfile" }).simfile;
  const cases = [
    {
      expected: /action sources/u,
      input: { action_source: scriptedSource, simfile: safe },
      name: "dynamics action source",
    },
    {
      expected: /scripted-controller config/u,
      input: {
        simfile: parseSimfileSource(source("\n    scripted_controller: {}"), {
          path: "Simfile",
        }).simfile,
      },
      name: "scripted_controller config",
    },
    {
      expected: /scripted-controller config/u,
      input: {
        simfile: parseSimfileSource(source("\n    scripted-controller: {}"), {
          path: "Simfile",
        }).simfile,
      },
      name: "scripted-controller config",
    },
    {
      expected: /--acts/u,
      input: { acts_path: "/tmp/local-acts.json", simfile: safe },
      name: "CLI --acts",
    },
  ] as const;

  for (const item of cases) {
    const directory = await mkdtemp(path.join(tmpdir(), "simfile-composed-preflight-"));
    try {
      const request = lifecycleRequest({ run_id: `run-${item.name.replaceAll(/[^a-z]+/gu, "-")}` });
      const harness = createComposedRunHarness(request);
      const journalPath = path.join(directory, "journal.json");
      await assert.rejects(runPreflightedComposedRun({
        configuration: harness.configuration,
        decision_inputs: item.input,
        journal_path: journalPath,
        ports: harness.ports,
        request,
      }), item.expected, item.name);
      assert.deepEqual(harness.telemetry.calls, [], item.name);
      assert.equal(harness.telemetry.participant_actions, 0, item.name);
      assert.equal(
        Object.values(harness.telemetry.effect_counts).every((count) => count === 0),
        true,
        item.name,
      );
      await assert.rejects(access(journalPath), { code: "ENOENT" }, item.name);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }
});
