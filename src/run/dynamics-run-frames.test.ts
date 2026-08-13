import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createDynamicsTestProject,
  removeDynamicsTestProject,
  tinyProviderSource
} from "../dynamics/testSupport.test-helper.js";
import { parseSimfileSource } from "../schema/parse.js";
import { writeDynamicsRunRecord } from "./dynamics-run-record.js";
import {
  DYNAMICS_RUN_FRAMES_HEADER_VERSION,
  DYNAMICS_RUN_FRAME_VERSION
} from "./dynamics-run-frames.js";

const SPATIAL_PROVIDER = tinyProviderSource().replace("    snapshot() {", `    spatial() {
      return {
        bounds: { max: [10, 6], min: [-10, -6] },
        objects: [{
          id: "object:counter",
          position: [state.value, 0],
          velocity: [state.value, -0]
        }]
      };
    },
    snapshot() {`);

const runRecord = async (providerSource: string, ticks: number): Promise<{
  lines: Array<Record<string, unknown>>;
  outDir: string;
  project: Awaited<ReturnType<typeof createDynamicsTestProject>>;
  text: string;
}> => {
  const project = await createDynamicsTestProject(providerSource);
  const outDir = path.join(project.directory, "run");
  await writeDynamicsRunRecord({

    outDir,
    runId: "frames-run",
    seed: "dynamics-seed",
    simfile: project.simfile,
    simfilePath: project.simfilePath,
    sourceText: await readFile(project.simfilePath, "utf8"),
    ticks,
    seams: { clock: () => new Date("2026-01-02T03:04:05.000Z") }
  });
  const text = await readFile(path.join(outDir, "raw/frames.jsonl"), "utf8");
  return {
    lines: text.split("\n").filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
    outDir,
    project,
    text
  };
};

describe("dynamics run frames", () => {
  it("records a self-describing header and one frame per tick including tick 0", async () => {
    const { lines, project } = await runRecord(SPATIAL_PROVIDER, 4);
    try {
      // N ticks means N+1 frames: the state before the first step is as real
      // as every later one, and `replay/initial-session.json` seals it too.
      assert.equal(lines.length, 6);
      assert.deepEqual(lines[0], {
        bounds: { max: [10, 6], min: [-10, -6] },
        sim_seconds_per_tick: 0.5,
        version: DYNAMICS_RUN_FRAMES_HEADER_VERSION
      });
      assert.deepEqual(lines.slice(1).map((line) => line.tick), [0, 1, 2, 3, 4]);
      for (const line of lines.slice(1)) {
        assert.equal(line.version, DYNAMICS_RUN_FRAME_VERSION);
        assert.equal(line.wall_elapsed_seconds, 0);
        assert.deepEqual(line.objects, [{
          id: "object:counter", position: [2, 0], velocity: [2, 0]
        }]);
      }
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("normalizes -0 so the recorded bytes and the projection agree", async () => {
    const { text, project } = await runRecord(SPATIAL_PROVIDER, 1);
    try {
      assert.equal(text.includes("-0"), false);
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("writes wall-clock ticks without fabricating bodies for a provider with no spatial()", async () => {
    // The file is always created so the artifact set — and therefore the
    // manifest's integrity envelope — stays uniform across providers. Tick
    // records carry timing even when there is no spatial projection.
    const { lines, project } = await runRecord(tinyProviderSource(), 3);
    try {
      assert.equal(lines.length, 4);
      assert.deepEqual(lines[0], {
        sim_seconds_per_tick: 0.5,
        version: DYNAMICS_RUN_FRAMES_HEADER_VERSION
      });
      for (const line of lines.slice(1)) {
        assert.equal("objects" in line, false);
        assert.equal(typeof line.wall_elapsed_seconds, "number");
      }
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("declares both frame contract versions in the manifest", async () => {
    const { outDir, project } = await runRecord(SPATIAL_PROVIDER, 1);
    try {
      const manifest = JSON.parse(
        await readFile(path.join(outDir, "manifest.json"), "utf8")
      ) as { artifacts: Array<{ path: string }>; contract_versions: Record<string, string> };
      assert.equal(manifest.contract_versions[DYNAMICS_RUN_FRAMES_HEADER_VERSION],
        DYNAMICS_RUN_FRAMES_HEADER_VERSION);
      assert.equal(manifest.contract_versions[DYNAMICS_RUN_FRAME_VERSION],
        DYNAMICS_RUN_FRAME_VERSION);
      // Inside the integrity envelope, not merely on disk.
      assert.equal(manifest.artifacts.some((entry) => entry.path === "raw/frames.jsonl"), true);
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("stays footerless and newline-terminated so a prefix is always readable", async () => {
    const { text, project } = await runRecord(SPATIAL_PROVIDER, 2);
    try {
      assert.equal(text.endsWith("\n"), true);
      const lines = text.split("\n").filter((line) => line.length > 0);
      // No trailer record: the last line is a tick like any other, so a reader
      // tailing a run in progress never waits for a terminator that a crashed
      // or still-running writer would never emit.
      assert.equal((JSON.parse(lines.at(-1)!) as { tick: number }).tick, 2);
    } finally {
      await removeDynamicsTestProject(project);
    }
  });

  it("records the same bytes for two runs of the same project", async () => {
    const project = await createDynamicsTestProject(SPATIAL_PROVIDER);
    try {
      const sourceText = await readFile(project.simfilePath, "utf8");
      const read = async (name: string): Promise<string> => {
        const outDir = path.join(project.directory, name);
        await writeDynamicsRunRecord({
          outDir, runId: "frames-run", seed: "dynamics-seed",
          simfile: project.simfile, simfilePath: project.simfilePath, sourceText, ticks: 5,
          seams: { clock: () => new Date("2026-01-02T03:04:05.000Z") }
        });
        return readFile(path.join(outDir, "raw/frames.jsonl"), "utf8");
      };
      assert.equal(await read("left"), await read("right"));
    } finally {
      await removeDynamicsTestProject(project);
    }
  });
});

describe("dynamics run frames under an action source", () => {
  it("records frames for the agent-driven step loop too", async () => {
    // The action-bearing loop is a SECOND step loop. A frames file that only
    // covered the action-free loop would leave exactly the agent-driven
    // matches — the ones worth watching — without a motion track.
    const root = await mkdtemp(path.join(tmpdir(), "simfile-frames-acted-"));
    try {
      await mkdir(path.join(root, "systems"));
      const looseFactory = "/** @type {() => (Record<string, any> & { "
        + "initialize?: (context: {config: Record<string, any>, [key: string]: any}) => any, "
        + "observe?: (request: Record<string, any>) => any, restore?: (snapshot: any) => any, "
        + "snapshot?: () => any, "
        + "step?: (input: {actions: any[], tick: any, [key: string]: any}) => any "
        + "})} */";
      await writeFile(path.join(root, "systems", "tiny.mjs"), `${
        SPATIAL_PROVIDER.replace("export const createDynamicsProvider =",
          `${looseFactory}\nexport const createDynamicsProvider =`)
      }
/** @type {() => Record<string, any>} */
export const createDynamicsRunActionSource = () => ({
  id: "frames-controller",
  live_acceptance: false,
  onTick(/** @type {Record<string, any>} */ context) {
    context.queueController({
      action: "increment",
      actor: "object:red",
      controller_id: "frames-red",
      controller_version: "test-v1",
      input: { amount: 1 },
      policy: "default",
      skill: "increment",
      target: "object:counter"
    });
  },
  participants: ["red"],
  provenance: "scripted",
  version: "simfile.dynamics-run-action-source.v1"
});
`, "utf8");
      const simfilePath = path.join(root, "Simfile");
      const sourceText = `
simfile_version: "0.1"
name: frames-action-test
clock:
  seed: frames-seed
  tick: 20ms
  sim_per_tick: 0.5s
world:
  id: counter
  grants:
    red:
      entity: entity:red
      senses: []
      affordances: []
dynamics:
  module: ./systems/tiny.mjs
  config:
    start: 2
`;
      await writeFile(simfilePath, sourceText, "utf8");
      const outDir = path.join(root, "run");
      await writeDynamicsRunRecord({
        outDir,
        runId: "frames-run",
        seed: "frames-seed",
        simfile: parseSimfileSource(sourceText, { path: simfilePath }).simfile,
        simfilePath,
        sourceText,
        ticks: 3,
        seams: { clock: () => new Date("2026-01-02T03:04:05.000Z") }
      });
      const lines = (await readFile(path.join(outDir, "raw/frames.jsonl"), "utf8"))
        .split("\n").filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.equal(lines.length, 5);
      assert.deepEqual(lines.slice(1).map((line) => line.tick), [0, 1, 2, 3]);
      // The bodies actually moved with the applied actions, rather than
      // repeating a frozen opening frame.
      assert.deepEqual(
        lines.slice(1).map((line) =>
          (line.objects as Array<{ position: [number, number] }>)[0]!.position[0]),
        [2, 3, 4, 5]
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
