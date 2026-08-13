import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { loadDynamicsRunActionSource } from "../dynamics/loadRunActionSource.js";
import { parseSimfileSource } from "../schema/parse.js";
import { captureCli } from "./action-source.test-helper.js";
import {
  prepareDynamicsRunWorldGrants,
  WorldRunCompositionError
} from "./world-grant-run.js";

type Project = Readonly<{
  out: string;
  simfilePath: string;
  sourceText: string;
}>;

const surfaceSource = `
export const createWorldSurfaceDefinition:
  () => WorldSurfaceDefinition = () => ({
  affordances: {},
  api_version: "simfile.world-surface.v1",
  effects: {},
  entities: {
    alpha: {
      address: "entity:alpha",
      dynamics_address: "object:alpha"
    }
  },
  senses: {
    "sense:hidden": {
      dynamics_senses: ["sense:hidden-state"],
      output: "simfile.numeric-observation.v1",
      project(input) {
        return {
          channels: input.observation.channels.map((channel) => ({
            components: channel.components,
            sense_address: "sense:hidden",
            subject_address: "entity:alpha"
          }))
        };
      }
    },
    "sense:open": {
      dynamics_senses: ["sense:open-state"],
      output: "simfile.numeric-observation.v1",
      project(input) {
        return {
          channels: input.observation.channels.map((channel) => ({
            components: channel.components,
            sense_address: "sense:open",
            subject_address: "entity:alpha"
          }))
        };
      }
    }
  }
});`;

const checkedSource = `
const queueCheck = (
  context: DynamicsRunActionSourceTick,
  label: string,
) => context.queueController({
  action: label,
  actor: "object:alpha",
  controller_id: label,
  controller_version: "test-v1",
  input: {},
  policy: "default",
  skill: "check",
  target: "object:alpha"
});

const expectDenied = (
  operation: () => unknown,
  context: DynamicsRunActionSourceTick,
  label: string,
) => {
  let denied = false;
  try {
    operation();
  } catch {
    denied = true;
  }
  if (!denied) throw new Error(label + " unexpectedly succeeded");
  queueCheck(context, label);
};

export const createDynamicsRunActionSource:
  DynamicsRunActionSourceFactory = () => ({
  id: "world-grant-checks",
  live_acceptance: false,
  onTick(context) {
    const observation = context.observe("alpha", {
      sense: "world://arena/sense/open"
    }) as {
      observation: {
        channels: readonly {
          components: Readonly<Record<string, number>>;
        }[];
      };
    };
    if (observation.observation.channels[0]?.components.value !== 7) {
      throw new Error("granted observation did not reach the provider");
    }
    queueCheck(context, "check-open");
    expectDenied(
      () => context.observe("alpha", {
        sense: "world://arena/sense/hidden"
      }),
      context,
      "check-ungranted"
    );
    expectDenied(
      () => context.observe("outsider", {
        sense: "world://arena/sense/open"
      }),
      context,
      "check-outsider"
    );
  },
  participants: ["alpha"],
  provenance: "scripted",
  version: "simfile.dynamics-run-action-source.v1"
});`;

const silentSource = `
export const createDynamicsRunActionSource:
  DynamicsRunActionSourceFactory = () => ({
  id: "world-grant-silent",
  live_acceptance: false,
  onTick() {},
  participants: ["alpha"],
  provenance: "scripted",
  version: "simfile.dynamics-run-action-source.v1"
});`;

const moduleSource = (
  withSurface: boolean,
  checked: boolean
): string => `
import type {
  DynamicsProviderModule,
  DynamicsRunActionSourceFactory,
  DynamicsRunActionSourceTick,
  WorldSurfaceDefinition
} from "simfile/dynamics";

export const createDynamicsProvider:
  DynamicsProviderModule["createDynamicsProvider"] = () => {
  const state = { value: 7 };
  return {
    api_version: "simfile.dynamics-provider.v1",
    id: "world-grant-provider",
    version: "1.0.0",
    state_schema_version: "world-grant.v1",
    initialize() {},
    observe(request) {
      return {
        channels: request.sense_addresses.map((sense_address) => ({
          components: { value: state.value },
          sense_address,
          subject_address: "object:alpha"
        }))
      };
    },
    restore(snapshot) {
      if (snapshot === null || typeof snapshot !== "object"
        || Array.isArray(snapshot) || snapshot.value !== 7) {
        throw new Error("invalid state");
      }
    },
    snapshot() { return { ...state }; },
    step(input) {
      return {
        action_results: input.actions.map((action) => ({
          accepted: true,
          sequence: action.sequence
        })),
        events: [],
        tick: input.tick
      };
    }
  };
};
${withSurface ? surfaceSource : ""}
${checked ? checkedSource : silentSource}
`;

const createProject = async (
  context: TestContext,
  options: Readonly<{
    checked: boolean;
    sense: string;
    withSurface: boolean;
  }>
): Promise<Project> => {
  const root = await mkdtemp(path.join(tmpdir(), "simfile-world-grants-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const systems = path.join(root, "systems");
  const simfilePath = path.join(root, "Simfile");
  const sourceText = `
simfile_version: "0.1"
name: world-grant-run-test
clock:
  seed: world-grant-run-test
  tick: 1ms
  sim_per_tick: 0.25s
world:
  id: arena
  grants:
    alpha:
      entity: entity:alpha
      senses: [${options.sense}]
      affordances: []
dynamics:
  module: ./systems/provider.ts
  config: {}
`;
  await mkdir(systems);
  await writeFile(
    path.join(systems, "provider.ts"),
    moduleSource(options.withSurface, options.checked)
  );
  await writeFile(simfilePath, sourceText);
  return {
    out: path.join(root, "run"),
    simfilePath,
    sourceText
  };
};

const recordMarkers = async (out: string): Promise<unknown[]> => {
  const [provenance, summary, manifest] = await Promise.all([
    readFile(path.join(out, "provenance.json"), "utf8"),
    readFile(path.join(out, "summary.json"), "utf8"),
    readFile(path.join(out, "manifest.json"), "utf8")
  ].map(async (file) => JSON.parse(await file) as Record<string, any>));
  return [
    provenance.world_grants,
    summary.world_grants,
    manifest.world.world_grants
  ];
};

test("wired run observation honors the exact sense manifest", async (context) => {
  const project = await createProject(context, {
    checked: true,
    sense: "sense:open",
    withSurface: true
  });
  const parsed = parseSimfileSource(project.sourceText, {
    path: project.simfilePath
  }).simfile;
  const loaded = await loadDynamicsRunActionSource(parsed, {
    seed: "world-grant-run-test",
    simfilePath: project.simfilePath
  });
  assert.ok(loaded?.surfaceRegistry);
  const prepared = prepareDynamicsRunWorldGrants({
    runId: "direct-check",
    session: loaded.session,
    simfile: parsed,
    surfaceRegistry: loaded.surfaceRegistry
  });
  assert.throws(
    () => prepared.participantHost?.read?.observe("outsider", {
      sense: "world://arena/sense/open"
    }),
    /participant observation denied/u
  );

  const result = await captureCli([
    "run", project.simfilePath, "--ticks", "1",
    "--run-id", "world-grant-wired", "--out", project.out
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  const marker = {
    observed: true,
    participants: ["alpha"],
    resolved: true,
    status: "declared-resolved"
  };
  assert.deepEqual(await recordMarkers(project.out), [marker, marker, marker]);
  const attempts = (await readFile(
    path.join(project.out, "raw/action-attempts.jsonl"),
    "utf8"
  )).trim().split("\n").map((line) => JSON.parse(line) as {
    attempt: { action: string };
  });
  assert.deepEqual(
    attempts.map((entry) => entry.attempt.action),
    ["check-open", "check-ungranted", "check-outsider"]
  );
});

test("a declared typo against an exported surface fails the run and aborts its record", async (context) => {
  const project = await createProject(context, {
    checked: false,
    sense: "sense:typo",
    withSurface: true
  });
  const result = await captureCli([
    "run", project.simfilePath, "--ticks", "1",
    "--run-id", "world-grant-over-broad", "--out", project.out
  ]);
  assert.notEqual(result.code, 0);
  assert.match(
    result.stderr,
    /world\.grants\.alpha\.senses\[0\] is not declared by the checked world surface/u
  );
  await assert.rejects(() => access(project.out), { code: "ENOENT" });
  await assert.rejects(
    () => access(path.join(project.out, "provenance.json")),
    { code: "ENOENT" }
  );
  await assert.rejects(
    () => access(path.join(project.out, "manifest.json")),
    { code: "ENOENT" }
  );
});

test("resolved grants reject a conflicting caller-supplied read port", async (context) => {
  const project = await createProject(context, {
    checked: false,
    sense: "sense:open",
    withSurface: true
  });
  const parsed = parseSimfileSource(project.sourceText, {
    path: project.simfilePath
  }).simfile;
  const loaded = await loadDynamicsRunActionSource(parsed, {
    seed: "world-grant-run-test",
    simfilePath: project.simfilePath
  });
  assert.ok(loaded?.surfaceRegistry);
  const refusals = Object.freeze({
    acknowledge: (_ordinal: number): void => {},
    read: (_afterOrdinal: number) => Object.freeze([]),
  });
  assert.throws(
    () => prepareDynamicsRunWorldGrants({
      participantHost: { refusals },
      runId: "caller-refusals-resolved",
      session: loaded.session,
      simfile: parsed,
      surfaceRegistry: loaded.surfaceRegistry,
    }),
    WorldRunCompositionError
  );
  const read = Object.freeze({
    observe: (): unknown => "caller observation"
  });
  const unresolved = prepareDynamicsRunWorldGrants({
    participantHost: { read },
    runId: "caller-read-unresolved",
    session: loaded.session,
    simfile: parsed
  });
  assert.equal(unresolved.participantHost?.read, read);
  assert.throws(
    () => prepareDynamicsRunWorldGrants({
      participantHost: { read },
      runId: "caller-read-resolved",
      session: loaded.session,
      simfile: parsed,
      surfaceRegistry: loaded.surfaceRegistry
    }),
    /caller-supplied dynamics run participant read port conflicts with resolved world grants/u
  );
  const controller = Object.freeze({ inspect: () => Object.freeze([]),
    queue: () => Object.freeze({ act_id: "forged", apply_tick: 0, queued: false }),
    settle: (step: unknown) => step });
  assert.throws(
    () => prepareDynamicsRunWorldGrants({
      participantHost: { controller: controller as never },
      runId: "caller-controller-resolved",
      session: loaded.session,
      simfile: parsed,
      surfaceRegistry: loaded.surfaceRegistry
    }),
    (error: unknown) => error instanceof Error && error.name === "WorldRunCompositionError"
      && error.message === "caller-supplied dynamics run participant controller conflicts with resolved world runtime"
  );
});

test("a hostile surface-less run remains explicitly unresolved", async (context) => {
  const project = await createProject(context, {
    checked: false,
    sense: "sense:open",
    withSurface: false
  });
  const result = await captureCli([
    "run", project.simfilePath, "--ticks", "1",
    "--run-id", "world-grant-no-surface", "--out", project.out
  ]);
  assert.equal(result.code, 0, result.stderr);
  const marker = {
    observed: false,
    participants: ["alpha"],
    resolved: false,
    status: "declared-unresolved"
  };
  assert.deepEqual(await recordMarkers(project.out), [marker, marker, marker]);
  for (const recorded of await recordMarkers(project.out)) {
    assert.notDeepEqual(recorded, {
      observed: false,
      participants: ["alpha"],
      resolved: true,
      status: "declared-resolved"
    });
  }
});
