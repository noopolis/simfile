import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type TestContext } from "node:test";

import { parseSimfileSource } from "../schema/parse.js";
import { type Simfile } from "../schema/model.js";
import { type LoadDynamicsSessionOptions } from "./load.js";

export interface LoadTestProject {
  readonly directory: string;
  readonly evidenceRoot: string;
  readonly modulePath: string;
  readonly options: LoadDynamicsSessionOptions;
  readonly scratchRoot: string;
  readonly simfile: Simfile;
  readonly simfilePath: string;
}

export interface CreateLoadTestProjectOptions {
  readonly configSource?: string;
  readonly extension?: ".mjs" | ".ts";
  readonly source: string;
}

export const providerFactorySource = (
  extension: ".mjs" | ".ts" = ".mjs",
  factoryPrelude = ""
): string => {
  const annotation = extension === ".ts"
    ? 'import type { DynamicsProviderModule } from "simfile/dynamics";\n'
      + 'export const createDynamicsProvider: DynamicsProviderModule["createDynamicsProvider"] ='
    : '/** @type {import("simfile/dynamics").DynamicsProviderModule["createDynamicsProvider"]} */\n'
      + "export const createDynamicsProvider =";
  return `${annotation} () => {
  ${factoryPrelude}
  let state = { value: 0 };
  return {
    api_version: "simfile.dynamics-provider.v1",
    dependencies: { "tiny-math": "1.0.0" },
    id: "sealed-counter",
    integration: { model: "sealed-counter" },
    version: "1.0.0",
    state_schema_version: "counter.v1",
    initialize(context) {
      state = { value: typeof context.config.start === "number" ? context.config.start : 0 };
    },
    observe() { return { channels: [] }; },
    restore(snapshot) {
      if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
        throw new Error("invalid fixture snapshot");
      }
      state = { value: typeof snapshot.value === "number" ? snapshot.value : 0 };
    },
    snapshot() { return { ...state }; },
    step(input) {
      return {
        action_results: input.actions.map((action) => ({ accepted: true, sequence: action.sequence })),
        events: [],
        tick: input.tick
      };
    }
  };
};
`;
};

export const createLoadTestProject = async (
  testContext: TestContext,
  input: CreateLoadTestProjectOptions
): Promise<LoadTestProject> => {
  const temporaryRoot = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(temporaryRoot, "simfile-load-project-"));
  const scratchRoot = await mkdtemp(path.join(temporaryRoot, "simfile-load-scratch-"));
  const evidenceRoot = await mkdtemp(path.join(temporaryRoot, "simfile-load-evidence-"));
  testContext.after(async () => {
    await Promise.all([directory, scratchRoot, evidenceRoot].map((root) =>
      rm(root, { force: true, recursive: true })));
  });
  const extension = input.extension ?? ".mjs";
  const moduleReference = `./systems/provider${extension}` as const;
  const modulePath = path.join(directory, "systems", `provider${extension}`);
  const simfilePath = path.join(directory, "Simfile");
  const simfileSource = `
simfile_version: "0.1"
name: load-test
clock:
  seed: load-seed
  tick: 20ms
  sim_per_tick: 0.5s
dynamics:
  module: ${moduleReference}
  config:
    ${(input.configSource ?? "start: 2").replaceAll("\n", "\n    ")}
`;
  await mkdir(path.dirname(modulePath), { recursive: true });
  await writeFile(modulePath, input.source, "utf8");
  await writeFile(simfilePath, simfileSource, "utf8");
  return {
    directory,
    evidenceRoot,
    modulePath,
    options: {
      artifactLifecycle: { evidenceRoot, scratchRoot },
      simfilePath
    },
    scratchRoot,
    simfile: parseSimfileSource(simfileSource, { path: simfilePath }).simfile,
    simfilePath
  };
};

export const assertPathMissing = async (fileName: string): Promise<void> => {
  try {
    await access(fileName);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`expected path to be absent: ${fileName}`);
};
