import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { parseRunManifest } from "../observe/manifest.js";

export interface ActionSourceProjectOptions {
  readonly actionsAtTickZero?: readonly string[];
  readonly actionsEveryTick?: readonly string[];
  readonly declarationPatch?: Readonly<{
    live_acceptance?: boolean;
  }>;
  readonly providerEventCausesAction?: boolean;
  readonly source?:
    | "absent"
    | "assert-context-exact-keys"
    | "queue-after-await"
    | "queues-one-then-returns-never"
    | "returns-never-settling-promise"
    | "silent"
    | "throw-with-call-counter";
}

export interface ActionSourceProject {
  readonly out: string;
  readonly root: string;
  readonly simfilePath: string;
  args(options: Readonly<{
    out?: string;
    runId?: string;
    ticks: number;
  }>): string[];
  file(relative: string, out?: string): string;
}

export const NONE_DECISION_SOURCE = Object.freeze({
  actors: Object.freeze([]) as readonly string[],
  kind: "none",
  model_decisions: false,
  provenance: "none"
});

export const SCRIPTED_SOURCE = Object.freeze({
  id: "test-scripted-source",
  live_acceptance: false,
  participants: Object.freeze(["blue", "red"]),
  provenance: "scripted",
  version: "simfile.dynamics-run-action-source.v1"
});

const cliSource = fileURLToPath(new URL("../cli/index.ts", import.meta.url));

export const captureCli = async (
  args: readonly string[],
  entry = cliSource
): Promise<{ code: number; stderr: string; stdout: string }> =>
  new Promise((resolve, reject) => {
    const prefix = entry.endsWith(".ts") ? ["--import", "tsx"] : [];
    const child = spawn(process.execPath, [...prefix, entry, ...args], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({
      code: code ?? 1,
      stderr: Buffer.concat(stderr).toString(),
      stdout: Buffer.concat(stdout).toString()
    }));
  });

export const readJson = async <Value>(file: string): Promise<Value> =>
  JSON.parse(await readFile(file, "utf8")) as Value;

export const readJsonl = async <Value>(
  file: string,
  expected: "empty" | "nonempty"
): Promise<Value[]> => {
  const text = await readFile(file, "utf8");
  if (expected === "empty") {
    assert.equal(text, "", file);
    return [];
  }
  assert.notEqual(text, "", file);
  assert.equal(text.endsWith("\n"), true, file);
  return text.trimEnd().split("\n").map((line) => JSON.parse(line) as Value);
};

const onTickSource = (options: ActionSourceProjectOptions): string => {
  if (options.source === "returns-never-settling-promise") {
    return "onTick() { return new Promise(() => {}); }";
  }
  if (options.source === "queues-one-then-returns-never") {
    return `onTick(context) {
      if (context.next_tick === 0) queueLabel(context, "move:red", 0);
      return new Promise(() => {});
    }`;
  }
  if (options.source === "assert-context-exact-keys") {
    return `onTick(context) {
      const keys = Reflect.ownKeys(context).sort();
      if (keys.join(",") !== "act,next_tick,observe,queueController,sim_time") {
        throw new Error("source context exposed unexpected authority");
      }
    }`;
  }
  if (options.source === "queue-after-await") {
    return `async onTick(context) {
      await undefined;
      try {
        queueLabel(context, "move:red", 0);
      } catch (error) {
        if (!(error instanceof Error)
          || error.message !== "dynamics run action source tick is closed") {
          throw error;
        }
      }
    }`;
  }
  if (options.source === "throw-with-call-counter") {
    return `onTick() {
      calls += 1;
      throw new Error("injected source failure call " + calls);
    }`;
  }
  const atZero = JSON.stringify(options.actionsAtTickZero ?? []);
  const every = JSON.stringify(options.actionsEveryTick ?? []);
  return `onTick(context) {
    const labels: readonly string[] = context.next_tick === 0 ? ${atZero} : [];
    for (const [index, label] of labels.entries()) {
      queueLabel(context, label, index);
    }
    for (const [index, label] of (${every} as readonly string[]).entries()) {
      queueLabel(context, label, labels.length + index);
    }
  }`;
};

const moduleSource = (options: ActionSourceProjectOptions): string => {
  const eventSource = options.providerEventCausesAction === true
    ? `const events: DynamicsEventDraft[] = input.actions.map((command) => ({
        cause_action_sequences: [command.sequence],
        kind: "counter.moved",
        payload: { sequence: command.sequence },
        source: command.actor,
        target: command.target
      }));`
    : "const events: DynamicsEventDraft[] = [];";
  const sourceAbsent = options.source === "absent";
  const live = options.declarationPatch?.live_acceptance ?? false;
  const actionSource = sourceAbsent ? "" : `
let calls = 0;
const queueLabel = (
  context: DynamicsRunActionSourceTick,
  label: string,
  index: number
) => {
  const parts = label.split(":");
  const actor = parts.length > 1 ? parts[1] : "actor";
  return context.queueController({
    action: label,
    actor: "object:" + actor,
    controller_id: parts[0] + "-" + actor + "-" + index,
    controller_version: "test-v1",
    input: { index },
    policy: "default",
    skill: parts[0],
    target: "object:counter"
  });
};
export const createDynamicsRunActionSource: DynamicsRunActionSourceFactory =
() => ({
  id: "test-scripted-source",
  live_acceptance: ${String(live)} as false,
  ${onTickSource(options)},
  participants: ["blue", "red"],
  provenance: "scripted",
  version: "simfile.dynamics-run-action-source.v1"
});`;
  return `
import type {
  DynamicsEventDraft,
  DynamicsProviderModule,
  DynamicsRunActionSourceFactory,
  DynamicsRunActionSourceTick
} from "simfile/dynamics";

export const createDynamicsProvider:
  DynamicsProviderModule["createDynamicsProvider"] = () => {
  let state = { value: 0 };
  return {
    api_version: "simfile.dynamics-provider.v1",
    id: "action-counter",
    version: "1.0.0",
    state_schema_version: "counter.v1",
    initialize() { state = { value: 0 }; },
    observe() { return { channels: [] }; },
    restore(snapshot) {
      if (snapshot === null || typeof snapshot !== "object"
        || Array.isArray(snapshot) || typeof snapshot.value !== "number") {
        throw new Error("invalid counter snapshot");
      }
      state = { value: snapshot.value };
    },
    snapshot() { return { ...state }; },
    step(input) {
      const action_results = input.actions.map((command) => ({
        accepted: true,
        sequence: command.sequence
      }));
      state.value += action_results.length;
      ${eventSource}
      return { action_results, events, tick: input.tick };
    }
  };
};
${actionSource}
`;
};

export const createActionSourceProject = async (
  testContext: TestContext,
  options: ActionSourceProjectOptions = {}
): Promise<ActionSourceProject> => {
  const root = await mkdtemp(path.join(tmpdir(), "simfile-action-source-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  const systems = path.join(root, "systems");
  const simfilePath = path.join(root, "Simfile");
  const out = path.join(root, "run");
  await mkdir(systems);
  await writeFile(path.join(systems, "provider.ts"), moduleSource(options));
  await writeFile(simfilePath, `
simfile_version: "0.1"
name: action-source-test
clock:
  seed: action-source-seed
  tick: 1ms
  sim_per_tick: 0.25s
world:
  id: counter
  grants:
    blue:
      entity: entity:blue
      senses: []
      affordances: []
    red:
      entity: entity:red
      senses: []
      affordances: []
dynamics:
  module: ./systems/provider.ts
  config: {}
`);
  return {
    out,
    root,
    simfilePath,
    args: ({ out: selectedOut = out, runId = "action-source-run", ticks }) => [
      "run",
      simfilePath,
      "--ticks",
      String(ticks),
      "--run-id",
      runId,
      "--out",
      selectedOut,
      "--clock",
      "2026-01-02T03:04:05.000Z"
    ],
    file: (relative, selectedOut = out) => path.join(selectedOut, relative)
  };
};

export const literalRecordPaths = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const candidate = path.join(directory, entry.name);
    if (!entry.isDirectory()) return [entry.name];
    return (await literalRecordPaths(candidate))
      .map((child) => path.join(entry.name, child));
  }));
  return nested.flat().sort();
};

export const assertManifestComplete = async (
  directory: string,
  paths: readonly string[]
): Promise<void> => {
  const manifest = parseRunManifest(
    await readJson(path.join(directory, "manifest.json"))
  );
  assert.deepEqual(
    manifest.artifacts.map((entry) => entry.path),
    paths.filter((entry) => entry !== "manifest.json")
  );
  for (const artifact of manifest.artifacts) {
    assert.equal(
      createHash("sha256")
        .update(await readFile(path.join(directory, artifact.path))).digest("hex"),
      artifact.sha256
    );
  }
};

const SEALED_PROVIDER_PATH =
  /^dynamics\/sha256-[0-9a-f]{64}\/provider\.mjs$/u;
const EXPECTED_SEALED_PROVIDER_PATH =
  "dynamics/sha256-<64 hex>/provider.mjs";
const EXPECTED_ACTION_RECORD_PATHS = [
  "dynamics/build-receipt.json",
  EXPECTED_SEALED_PROVIDER_PATH,
  "manifest.json",
  "provenance.json",
  "raw/action-attempts.jsonl",
  "raw/action-results.jsonl",
  "raw/commitment-outcomes.jsonl",
  // B192: the per-tick motion track, written by the action-bearing step loop
  // too. An action-driven match that produced no frames would fail here.
  "raw/frames.jsonl",
  "raw/steps.jsonl",
  "raw/world/action-refusals.jsonl",
  "raw/world/causal.jsonl",
  "raw/world/perception.jsonl",
  "replay/action-stream.json",
  "replay/final-session.json",
  "replay/initial-session.json",
  "summary.json",
  "viewer-extensions.json"
];

const normalizeSealedProviderPath = (
  paths: readonly string[]
): string[] => paths.map((relative) =>
  SEALED_PROVIDER_PATH.test(relative)
    ? EXPECTED_SEALED_PROVIDER_PATH
    : relative
);

export const assertRecordsByteIdentical = async (
  left: string,
  right: string
): Promise<void> => {
  const leftPaths = await literalRecordPaths(left);
  const rightPaths = await literalRecordPaths(right);
  assert.deepEqual(
    normalizeSealedProviderPath(leftPaths),
    EXPECTED_ACTION_RECORD_PATHS
  );
  assert.deepEqual(
    normalizeSealedProviderPath(rightPaths),
    EXPECTED_ACTION_RECORD_PATHS
  );
  await assertManifestComplete(left, leftPaths);
  await assertManifestComplete(right, rightPaths);
  assert.deepEqual(rightPaths, leftPaths);
  for (const relative of leftPaths) {
    assert.deepEqual(
      await readFile(path.join(right, relative)),
      await readFile(path.join(left, relative)),
      relative
    );
  }
};
