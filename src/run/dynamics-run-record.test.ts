import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, open, readFile, realpath, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parseCausalJsonl } from "@noopolis/stele";
import { createDynamicsTestProject, removeDynamicsTestProject, tinyProviderSource } from "../dynamics/testSupport.test-helper.js";
import { createCanonicalEventEnvelope } from "../ledger/stable.js";
import { parseSimfileSource } from "../schema/parse.js";
import type { Simfile } from "../schema/model.js";
import {
  dynamicsRunStagingPrefix,
  type DynamicsRunFileOperations
} from "./dynamics-run-artifacts.js";
import type { DynamicsRunRecordSeams } from "./dynamics-run-record.js";
import { writeDynamicsRunRecord } from "./dynamics-run-record.js";
const realOperations: DynamicsRunFileOperations = {
  mkdir, mkdtemp, open, readFile, realpath, rename, rm, rmdir
};

const files = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      for (const child of await files(path.join(directory, entry.name))) {
        result.push(path.join(entry.name, child));
      }
    } else {
      result.push(entry.name);
    }
  }
  return result.sort();
};

const messages = (value: unknown): string[] => {
  if (!(value instanceof Error)) return [String(value)];
  const result = [value.message];
  if (value instanceof AggregateError) {
    for (const error of value.errors) result.push(...messages(error));
  }
  if (value.cause !== undefined) result.push(...messages(value.cause));
  return result;
};

const baseOptions = async (
  project: Awaited<ReturnType<typeof createDynamicsTestProject>>,
  outDir: string,
  overrides: Partial<Parameters<typeof writeDynamicsRunRecord>[0]> = {}
) => {
  const { seams, ...rest } = overrides;
  return {
    outDir, runId: "dynamics-test-run", seed: "dynamics-seed",
    simfile: project.simfile, simfilePath: project.simfilePath,
    sourceText: await readFile(project.simfilePath, "utf8"), ticks: 2,
    ...rest,
    seams: { clock: () => new Date("2026-01-02T03:04:05.000Z"), ...seams }
  };
};

describe("writeDynamicsRunRecord", () => {
  it("requires an injected clock seam", () => {
    // @ts-expect-error A record seam without a clock must not type-check.
    const missingClock: DynamicsRunRecordSeams = {};
    assert.deepEqual(missingClock, {});
  });

  it("writes honest checkpoints, causal data, and the exact evidence pair", async () => {
    const project = await createDynamicsTestProject();
    try {
      const outDir = path.join(project.directory, "run");
      await writeDynamicsRunRecord(await baseOptions(project, outDir));
      const initial = JSON.parse(
        await readFile(path.join(outDir, "replay/initial-session.json"), "utf8")
      ) as { next_tick: number; provenance: { module_sha256: string } };
      const final = JSON.parse(
        await readFile(path.join(outDir, "replay/final-session.json"), "utf8")
      ) as { next_tick: number };
      assert.equal(initial.next_tick, 0);
      assert.equal(final.next_tick, 2);
      const actionStream = JSON.parse(
        await readFile(path.join(outDir, "replay/action-stream.json"), "utf8")
      ) as Record<string, unknown>;
      assert.equal(Object.hasOwn(actionStream, "actions"), true);
      assert.deepEqual(actionStream.actions, []);
      assert.equal(await readFile(path.join(
        outDir, "raw/action-attempts.jsonl"
      ), "utf8"), "");
      assert.equal(await readFile(path.join(
        outDir, "raw/action-results.jsonl"
      ), "utf8"), "");
      assert.equal(await readFile(path.join(
        outDir, "raw/world/action-refusals.jsonl"
      ), "utf8"), "");

      const provenance = JSON.parse(
        await readFile(path.join(outDir, "provenance.json"), "utf8")
      ) as {
        build_receipt_sha256: string;
        decision_source: unknown;
        world_grants: unknown;
      };
      assert.deepEqual(provenance.decision_source,
        { actors: [], kind: "none", model_decisions: false, provenance: "none" });
      assert.deepEqual(provenance.world_grants, {
        observed: false, participants: [], resolved: false, status: "none-declared" });
      const receiptBytes = await readFile(path.join(
        outDir, "dynamics/build-receipt.json"
      ));
      assert.equal(
        createHash("sha256").update(receiptBytes).digest("hex"),
        provenance.build_receipt_sha256
      );
      const receipt = JSON.parse(receiptBytes.toString()) as {
        artifact_path: string;
        artifact_sha256: string;
      };
      assert.equal(receipt.artifact_sha256, initial.provenance.module_sha256);
      const artifactBytes = await readFile(path.join(outDir, receipt.artifact_path));
      assert.equal(
        createHash("sha256").update(artifactBytes).digest("hex"),
        receipt.artifact_sha256
      );

      const causalSource = await readFile(
        path.join(outDir, "raw/world/causal.jsonl"), "utf8"
      );
      const manifest = JSON.parse(await readFile(
        path.join(outDir, "manifest.json"), "utf8"
      )) as { contract_versions: Record<string, string> };
      assert.equal(
        manifest.contract_versions["simfile.world-run-action-refusal.v2"],
        "simfile.world-run-action-refusal.v2",
      );
      const parsed = parseCausalJsonl(causalSource);
      assert.deepEqual(parsed.errors, []);
      assert.equal(parsed.events.length, 4);
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("attributes provider events to their provider source", async () => {
    const provider = tinyProviderSource().replace(
      "return { action_results, events, tick: input.tick };",
      `events.push({
        cause_action_sequences: [],
        kind: "counter.heartbeat",
        payload: { tick: input.tick },
        source: "provider:tiny",
        target: "world:tiny"
      });
      return { action_results, events, tick: input.tick };`
    );
    const project = await createDynamicsTestProject(provider);
    try {
      const outDir = path.join(project.directory, "run");
      await writeDynamicsRunRecord(await baseOptions(project, outDir, { ticks: 1 }));
      const records = (await readFile(
        path.join(outDir, "raw/world/causal.jsonl"), "utf8"
      )).trim().split("\n").map((line) => JSON.parse(line) as {
        type: string;
        payload: { actor: string; target: string; provenance: string };
      });
      const event = records.find((record) => record.type === "counter.heartbeat");
      assert.deepEqual(event?.payload, { actor: "provider:tiny",
        cause_action_sequences: [], event_sequence: 1, kind: "counter.heartbeat",
        payload: { tick: 0 }, provenance: "mechanical", scope: "world:dynamics",
        sim_time: 0, source: "provider:tiny", target: "world:tiny", tick: 0 });
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("N5 removes staging and reservation when the module is missing", async () => {
    const project = await createDynamicsTestProject();
    try {
      const outDir = path.join(project.directory, "run");
      const missingModule = "./systems/not-there.mjs";
      const missingPath = path.join(project.directory, "systems/not-there.mjs");
      const simfile: Simfile = {
        ...project.simfile,
        dynamics: { config: {}, module: missingModule }
      };
      await assert.rejects(
        writeDynamicsRunRecord(await baseOptions(project, outDir, { simfile })),
        (error) => messages(error).some((message) => message.includes(missingPath))
      );
      await assert.rejects(access(outDir));
      assert.deepEqual((await readdir(project.directory))
        .filter((entry) => entry.startsWith(dynamicsRunStagingPrefix(outDir))), []);
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("N6 aborts immediately when step throws and does not retry", async () => {
    const provider = tinyProviderSource()
      .replace("let state =", "let calls = 0;\n  let state =")
      .replace(
        "step(input) {\n      const action_results",
        `step(input) {
      calls += 1;
      if (input.tick === 3) throw new Error("provider-step-calls-" + calls);
      const action_results`
      );
    const project = await createDynamicsTestProject(provider);
    try {
      const outDir = path.join(project.directory, "run");
      await assert.rejects(
        writeDynamicsRunRecord(await baseOptions(project, outDir, { ticks: 8 })),
        (error) => messages(error).includes("provider-step-calls-4")
      );
      await assert.rejects(access(outDir));
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("N10e combines step and abort failures in nested primary-first order", async () => {
    const provider = tinyProviderSource().replace(
      "step(input) {\n      const action_results",
      `step(input) {
      if (input.tick === 3) throw new Error("provider-step-N10e");
      const action_results`
    );
    const project = await createDynamicsTestProject(provider);
    const rmFailure = new Error("N10e-rm");
    try {
      const outDir = path.join(project.directory, "run");
      const operations = {
        ...realOperations,
        rm: (async (...args: Parameters<typeof rm>) => {
          if (String(args[0]).includes(dynamicsRunStagingPrefix(outDir))) throw rmFailure;
          return rm(...args);
        }) as typeof rm
      };
      await assert.rejects(
        writeDynamicsRunRecord(await baseOptions(project, outDir, {
          ticks: 8, seams: { clock: () => new Date("2026-01-02T03:04:05.000Z"), fileOperations: operations }
        })),
        (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(
            error.message, "dynamics run failed and record abort also failed"
          );
          assert.ok(messages(error.errors[0]).includes("provider-step-N10e"));
          const abort = error.errors[1];
          assert.ok(abort instanceof AggregateError);
          assert.equal(abort.message, "dynamics run artifact abort failed");
          assert.equal(abort.errors[0], rmFailure);
          return true;
        }
      );
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("N10f combines load and scratch cleanup failures primary-first", async () => {
    const project = await createDynamicsTestProject();
    const rmFailure = new Error("N10f-rm");
    const scratchPaths: string[] = [];
    try {
      const outDir = path.join(project.directory, "run");
      const missingModule = "./systems/not-there.mjs";
      const missingPath = path.join(project.directory, "systems/not-there.mjs");
      const simfile: Simfile = {
        ...project.simfile,
        dynamics: { config: {}, module: missingModule }
      };
      const operations = {
        ...realOperations,
        rm: (async (...args: Parameters<typeof rm>) => {
          if (String(args[0]).includes("simfile-dynamics-run-scratch-")) {
            scratchPaths.push(String(args[0]));
            throw rmFailure;
          }
          return rm(...args);
        }) as typeof rm
      };
      await assert.rejects(
        writeDynamicsRunRecord(await baseOptions(project, outDir, {
          simfile, seams: { clock: () => new Date("2026-01-02T03:04:05.000Z"), fileOperations: operations }
        })),
        (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.message,
            "dynamics session load and scratch cleanup both failed");
          assert.equal(messages(error.errors[0]).some((message) =>
            message.includes(missingPath)), true);
          assert.equal(error.errors[1], rmFailure);
          return true;
        }
      );
      await assert.rejects(access(outDir));
    } finally {
      for (const scratch of scratchPaths) {
        await rm(scratch, { force: true, recursive: true });
      }
      await removeDynamicsTestProject(project);
    }
  });

  it("N10g treats successful-load scratch cleanup failure as primary", async () => {
    const project = await createDynamicsTestProject();
    const rmFailure = new Error("N10g-rm");
    const scratchPaths: string[] = [];
    try {
      const outDir = path.join(project.directory, "run");
      const operations = {
        ...realOperations,
        rm: (async (...args: Parameters<typeof rm>) => {
          if (String(args[0]).includes("simfile-dynamics-run-scratch-")) {
            scratchPaths.push(String(args[0]));
            throw rmFailure;
          }
          return rm(...args);
        }) as typeof rm
      };
      await assert.rejects(
        writeDynamicsRunRecord(await baseOptions(project, outDir, {
          seams: { clock: () => new Date("2026-01-02T03:04:05.000Z"), fileOperations: operations }
        })),
        (error) => error === rmFailure
      );
      await assert.rejects(access(outDir));
    } finally {
      for (const scratch of scratchPaths) {
        await rm(scratch, { force: true, recursive: true });
      }
      await removeDynamicsTestProject(project);
    }
  });

  it("T7 produces byte-identical records for identical inputs", async () => {
    const project = await createDynamicsTestProject();
    try {
      const left = path.join(project.directory, "left");
      const right = path.join(project.directory, "right");
      await writeDynamicsRunRecord(await baseOptions(project, left));
      await writeDynamicsRunRecord(await baseOptions(project, right));
      const layout = await files(left);
      assert.deepEqual(await files(right), layout);
      for (const relative of layout) {
        assert.deepEqual(
          await readFile(path.join(left, relative)),
          await readFile(path.join(right, relative))
        );
      }
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("T9 preserves the literal source path and leaks no owned temp path", async () => {
    const project = await createDynamicsTestProject();
    try {
      const localDirectory = path.join(
        process.cwd(), `.simfile-run-record-t9-${path.basename(project.directory)}`
      );
      await rename(project.directory, localDirectory);
      project.directory = localDirectory;
      project.modulePath = path.join(localDirectory, "systems/tiny.mjs");
      project.simfilePath = path.join(localDirectory, "Simfile");
      const outDir = path.join(project.directory, "run");
      const stagingParent = path.join(project.directory, "staging-parent");
      await mkdir(stagingParent);
      const relativePath = path.relative(process.cwd(), project.simfilePath);
      await writeDynamicsRunRecord(await baseOptions(project, outDir, {
        simfilePath: relativePath,
        seams: { clock: () => new Date("2026-01-02T03:04:05.000Z"), stagingParent }
      }));
      const provenance = JSON.parse(
        await readFile(path.join(outDir, "provenance.json"), "utf8")
      ) as { source: { path: string } };
      assert.equal(provenance.source.path, relativePath);
      const forbidden = [process.cwd(), tmpdir(), await realpath(tmpdir()),
        stagingParent, dynamicsRunStagingPrefix(outDir)];
      for (const relative of await files(outDir)) {
        const source = await readFile(path.join(outDir, relative), "utf8");
        for (const value of forbidden) assert.equal(source.includes(value), false);
      }
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("T10 derives manifest and event timestamps from simulated time", async () => {
    const project = await createDynamicsTestProject();
    try {
      const source = (await readFile(project.simfilePath, "utf8"))
        .replace("sim_per_tick: 0.5s", "sim_per_tick: 1.5ms");
      await writeFile(project.simfilePath, source, "utf8");
      const simfile = parseSimfileSource(source, { path: project.simfilePath }).simfile;
      const outDir = path.join(project.directory, "run");
      await writeDynamicsRunRecord(await baseOptions(project, outDir, {
        simfile, sourceText: source, ticks: 3,
        seams: { clock: () => new Date("2026-01-02T03:04:05.000Z") }
      }));
      const manifest = JSON.parse(
        await readFile(path.join(outDir, "manifest.json"), "utf8")
      ) as { created_at: string };
      assert.equal(manifest.created_at, "2026-01-02T03:04:05.000Z");
      const records = (await readFile(
        path.join(outDir, "raw/world/causal.jsonl"), "utf8"
      )).trim().split("\n").map((line) => JSON.parse(line) as {
        payload: { sim_time: number };
        recorded_at: string;
      });
      for (const record of records) {
        const expected = createCanonicalEventEnvelope({
          runId: "timestamp", seq: 1, kind: "timestamp",
          simTime: record.payload.sim_time, provenance: "mechanical",
          actor: "system:test", target: "world:test", scope: "world:test",
          payload: {}
        }).recorded_at;
        assert.equal(record.recorded_at, expected);
      }
    } finally {
      await removeDynamicsTestProject(project);
    }
  });
});
