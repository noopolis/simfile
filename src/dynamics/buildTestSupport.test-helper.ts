import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  compareUtf16,
  createDynamicsClosureIdentity,
  sha256,
  type DynamicsBuildInputDescriptor
} from "./buildIdentity.js";
import { prepareDynamicsBuild } from "./build.js";

type UnknownRecord = Readonly<Record<string, unknown>>;
type DynamicsClosureShape = {
  readonly buildContract: UnknownRecord;
  readonly entry: string;
  readonly esbuildVersion: string;
  readonly inputs: readonly DynamicsBuildInputDescriptor[];
  readonly preparationPolicy: UnknownRecord;
  readonly typecheckMode: "none" | "typescript";
  readonly typescriptVersion: string;
  readonly usedNodeBuiltins: readonly string[];
};

export interface BuildTestProject {
  readonly directory: string;
  readonly simfilePath: string;
}

export type LocaleProcessLocale = "en-US" | "sv-SE";

export interface LocaleChildResult {
  readonly childPid: number;
  readonly requestedLocale: LocaleProcessLocale;
  readonly resolvedLocale: string;
  readonly controlOrder: readonly string[];
  readonly prepared: PreparedBuild;
  readonly localeEnvironment: {
    readonly lang: string | undefined;
    readonly lcAll: string | undefined;
  };
}

export type PreparedBuild = Awaited<ReturnType<typeof prepareDynamicsBuild>>;

export interface InputMutationComparison {
  readonly baseline: PreparedBuild;
  readonly mutated: PreparedBuild;
  readonly expectedChangedInputKey: string;
}

const buildModuleUrl = new URL("./build.js", import.meta.url).href;

const localeEnvironment = Object.freeze({
  "en-US": "en_US.UTF-8",
  "sv-SE": "sv_SE.UTF-8"
} as const satisfies Record<LocaleProcessLocale, string>);

const readStreamText = async (stream: NodeJS.ReadableStream): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

const isDeepEqual = (left: unknown, right: unknown): boolean => {
  try {
    assert.deepEqual(left, right);
    return true;
  } catch {
    return false;
  }
};

const makeInputDescriptorKey = (descriptor: DynamicsBuildInputDescriptor): string => {
  switch (descriptor.kind) {
    case "project":
      return `project:${descriptor.path}`;
    case "package":
      return `package:${descriptor.package_name}:${descriptor.package_path}`;
    default:
      return "type-only:simfile:dynamics";
  }
};

const mapInputDescriptorsByKey = (prepared: PreparedBuild): Map<string, DynamicsBuildInputDescriptor> => {
  const entries = new Map<string, DynamicsBuildInputDescriptor>();
  for (const input of prepared.inputs) {
    entries.set(makeInputDescriptorKey(input), input);
  }
  return entries;
};

export const assertPreparedSingleInputMutation = (fixture: InputMutationComparison): void => {
  const baselineInputs = mapInputDescriptorsByKey(fixture.baseline);
  const mutatedInputs = mapInputDescriptorsByKey(fixture.mutated);
  const baselineKeys = [...baselineInputs.keys()].sort(compareUtf16);
  const mutatedKeys = [...mutatedInputs.keys()].sort(compareUtf16);
  assert.deepEqual(baselineKeys, mutatedKeys);
  const changedInputKeys = baselineKeys.filter((key) =>
    !isDeepEqual(baselineInputs.get(key), mutatedInputs.get(key))
  );
  assert.deepEqual(changedInputKeys.length, 1);
  assert.deepEqual(changedInputKeys[0], fixture.expectedChangedInputKey);
  assert.equal(
    isDeepEqual(fixture.baseline.closureDescriptor, fixture.mutated.closureDescriptor),
    false
  );
  assert.equal(fixture.baseline.closureSha256 === fixture.mutated.closureSha256, false);
  assert.equal(closureHeader(fixture.baseline) === closureHeader(fixture.mutated), false);
  assert.equal(fixture.baseline.artifactSha256 === fixture.mutated.artifactSha256, false);
  assert.equal(isDeepEqual(fixture.baseline.artifactBytes, fixture.mutated.artifactBytes), false);
  assert.deepEqual(fixture.baseline.inputs.length, fixture.mutated.inputs.length);
};
export const assertUnreachableFileMutationNoEffect = async (
  project: BuildTestProject
): Promise<void> => {
  await writeBuildFile(project, "systems/provider.mjs", "export const value = 1;\n");
  const baseline = await prepareBuild(project);
  await writeBuildFile(project, "systems/unrelated.ts", "export const value = 1;\n");
  const afterAdd = await prepareBuild(project);
  assert.deepEqual(afterAdd, baseline);
  await writeBuildFile(project, "systems/unrelated.ts", "export const value = 2;\n");
  const afterMutate = await prepareBuild(project);
  assert.deepEqual(afterMutate, baseline);
};
export const makePackage = async (
  projectDirectory: string,
  name: string,
  version: string,
  source: string,
  entry = "./index.mjs"
): Promise<string> => {
  const pkgDirectory = path.join(projectDirectory, "node_modules", name);
  await writeBuildFile({ directory: pkgDirectory }, "package.json", JSON.stringify({ name, version, type: "module", main: entry }));
  await writeBuildFile({ directory: pkgDirectory }, entry.slice(2), source);
  return pkgDirectory;
};
export const runPreparedSingleInputMutationFixture = async (
  setup: (project: BuildTestProject) => Promise<unknown>,
  mutate: (project: BuildTestProject) => Promise<PreparedBuild>,
  expectedChangedInputKey: string,
  module = "./systems/provider.mjs"
): Promise<void> => {
  const project = await createBuildTestProject();
  try {
    await setup(project);
    const baseline = await prepareBuild(project, module);
    const mutated = await mutate(project);
    assertPreparedSingleInputMutation({ baseline, mutated, expectedChangedInputKey });
  } finally {
    await removeBuildTestPaths(project.directory);
  }
};
const asStrings = (value: unknown): readonly string[] => Array.isArray(value)
  ? value.filter((entry): entry is string => typeof entry === "string")
  : [];
const asRecord = (value: unknown): UnknownRecord => (value && typeof value === "object" && !Array.isArray(value))
  ? value as UnknownRecord
  : {};
export const buildShapeFromPrepared = (prepared: PreparedBuild): DynamicsClosureShape => ({
  buildContract: asRecord(prepared.closureDescriptor.build_contract),
  entry: prepared.closureDescriptor.entry as string,
  esbuildVersion: prepared.closureDescriptor.esbuild_version as string,
  inputs: prepared.inputs,
  preparationPolicy: asRecord(prepared.closureDescriptor.preparation_policy),
  typecheckMode: prepared.typecheckMode,
  typescriptVersion: prepared.closureDescriptor.typescript_version as string,
  usedNodeBuiltins: asStrings(prepared.closureDescriptor.used_node_builtins)
}) as DynamicsClosureShape;
export const assertAxisMutationHeaderEffect = (
  baseline: PreparedBuild,
  buildMutated: (shape: DynamicsClosureShape) => ReturnType<typeof createDynamicsClosureIdentity>
): void => {
  const mutated = buildMutated(buildShapeFromPrepared(baseline));
  assert.notDeepEqual(mutated.descriptor, baseline.closureDescriptor);
  assert.equal(mutated.sha256 === baseline.closureSha256, false);
  assert.equal(mutated.header.includes(mutated.sha256), true);
  assert.equal(mutated.header === closureHeader(baseline), false);
  const headerBytes = new TextEncoder().encode(closureHeader(baseline));
  const emittedBody = Buffer.from(baseline.artifactBytes.slice(headerBytes.length));
  const mutatedHeaderBytes = new TextEncoder().encode(mutated.header);
  const rebuilt = new Uint8Array(mutatedHeaderBytes.length + emittedBody.length);
  rebuilt.set(mutatedHeaderBytes);
  rebuilt.set(emittedBody, mutatedHeaderBytes.length);
  const rebuiltBody = Buffer.from(rebuilt.slice(mutatedHeaderBytes.length));
  assert.equal(rebuiltBody.compare(emittedBody), 0);
  assert.equal(sha256(rebuilt) === baseline.artifactSha256, false);
};
export const runAxisMutationFixture = async (
  buildMutated: (shape: DynamicsClosureShape) => ReturnType<typeof createDynamicsClosureIdentity>
): Promise<void> => {
  const project = await createBuildTestProject();
  try {
    await writeBuildFile(project, "systems/provider.mjs", "export const value = 1;\n");
    const baseline = await prepareBuild(project);
    assertAxisMutationHeaderEffect(baseline, buildMutated);
  } finally {
    await removeBuildTestPaths(project.directory);
  }
};
export const createBuildTestProject = async (parent = os.tmpdir()): Promise<BuildTestProject> => {
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, "simfile-build-"));
  const simfilePath = path.join(directory, "Simfile");
  await writeFile(simfilePath, "clock: {}\n", "utf8");
  return { directory, simfilePath };
};
export const writeBuildFile = async (project: Pick<BuildTestProject, "directory">, relative: string, source: string): Promise<string> => {
  const fileName = path.join(project.directory, ...relative.split("/"));
  await mkdir(path.dirname(fileName), { recursive: true });
  await writeFile(fileName, source, "utf8");
  return fileName;
};
export const prepareBuild = (project: BuildTestProject, module = "./systems/provider.mjs") =>
  prepareDynamicsBuild(project.simfilePath, module);
export const removeBuildTestPaths = async (...paths: string[]): Promise<void> => {
  await Promise.all(paths.map((entry) => rm(entry, { force: true, recursive: true })));
};
export const artifactText = (prepared: PreparedBuild): string =>
  Buffer.from(prepared.artifactBytes).toString("utf8");
export const closureHeader = (prepared: PreparedBuild): string =>
  `/* simfile-dynamics-closure-sha256:${prepared.closureSha256} */\n`;
export const preparedArtifactBody = (prepared: PreparedBuild): readonly number[] => {
  const headerLength = new TextEncoder().encode(closureHeader(prepared)).byteLength;
  return prepared.artifactBytes.slice(headerLength);
};
export const preparedArtifactText = (prepared: PreparedBuild): string =>
  Buffer.from(preparedArtifactBody(prepared)).toString("utf8");
export const collectStringValues = (value: unknown, output: string[] = []): string[] => {
  if (typeof value === "string") {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const child of value) collectStringValues(child, output);
    return output;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) collectStringValues(child, output);
  }
  return output;
};
const absolutePathPatterns = [
  /(?:^|[\s"'`])([A-Za-z]:[\\/][^\s"'`]+)/gu,
  /(?:^|[\s"'`])(\/[A-Za-z0-9._\-~%+]+(?:\/[A-Za-z0-9._\-~%+]+)*)/gu,
] as const;
const isAllowedTextReference = (value: string): boolean =>
  value.startsWith("node:") || value.startsWith("./") || value.startsWith("../") || value === "dynamics.mjs";
export const assertNoFilesystemPathLeaks = (prepared: PreparedBuild, fixtureRoot: string): void => {
  const parentRoot = path.resolve(path.dirname(fixtureRoot));
  const forbidden = [fixtureRoot, parentRoot].flatMap((candidate) => {
    const normalized = path.resolve(candidate);
    return [
      candidate,
      normalized,
      normalized.replace(/\\/gu, "/"),
      path.posix.normalize(normalized),
      path.win32.normalize(normalized)
    ];
  });
  const values = [
    ...collectStringValues(prepared),
    artifactText(prepared)
  ];
  const trimPunctuation = (value: string): string =>
    value.replace(/[),.;:]$/u, "").replace(/[*]+$/u, "");
  const hasAbsolutePath = (value: string): boolean => {
    for (const pattern of absolutePathPatterns) {
      for (const match of value.matchAll(pattern)) {
        const candidate = match[1] ?? match[0].trimStart();
        if (!candidate) continue;
        if (candidate.startsWith("/*")) continue;
        const portable = trimPunctuation(candidate);
        if (isAllowedTextReference(candidate)) continue;
        if (path.posix.isAbsolute(portable)) return true;
        if (/^[A-Za-z]:[\\/]/u.test(portable) || /^\\\\/u.test(portable)) return true;
      }
    }
    return false;
  };
  for (const value of values) {
    assert.equal(
      forbidden.some((candidate) => candidate.length > 0 && value.includes(candidate)),
      false,
      `forbidden root leak: ${value}`
    );
    assert.equal(
      hasAbsolutePath(value),
      false,
      `unexpected absolute filesystem path: ${value}`
    );
  }
};
export const prepareBuildInLocaleChild = async (
  projectDirectory: string,
  locale: LocaleProcessLocale,
  module = "./systems/provider.mjs"
): Promise<LocaleChildResult> => {
  const expectedEnvironment = localeEnvironment[locale];
  const script = [
    "import path from \"node:path\";",
    `import { prepareDynamicsBuild } from \"${buildModuleUrl}\";`,
    `const projectDirectory = ${JSON.stringify(projectDirectory)};`,
    `const moduleReference = ${JSON.stringify(module)};`,
    "const requestedLocale = process.env.SIMFILE_TEST_LOCALE ?? \"en-US\";",
    "const expectedEnvironment = process.env.SIMFILE_TEST_LOCALE_ENV ?? undefined;",
    "if (!expectedEnvironment) throw new Error(\"missing expected child locale environment\");",
    "const lang = process.env.LANG;",
    "const lcAll = process.env.LC_ALL;",
    "if (lang !== expectedEnvironment || lcAll !== expectedEnvironment) {",
    "  throw new Error(`child locale env mismatch: LANG=${lang} LC_ALL=${lcAll} expected=${expectedEnvironment}`);",
    "}",
    "const normalizedRequested = requestedLocale.replace('_', '-').toLowerCase();",
    "const collator = new Intl.Collator(undefined, { usage: \"sort\", sensitivity: \"variant\" });",
    "const resolvedLocale = collator.resolvedOptions().locale;",
    "if (!resolvedLocale.toLowerCase().startsWith(normalizedRequested)) {",
    "  throw new Error(`child locale mismatch: ${requestedLocale} -> ${resolvedLocale}`);",
    "}",
    "const controlOrder = [\"ä\", \"z\"].sort((left, right) => collator.compare(left, right));",
    "const prepared = await prepareDynamicsBuild(path.join(projectDirectory, \"Simfile\"), moduleReference);",
    "process.stdout.write(JSON.stringify({",
    "  childPid: process.pid,",
    "  requestedLocale,",
    "  resolvedLocale,",
    "  controlOrder,",
    "  localeEnvironment: {",
    "    lang,",
    "    lcAll",
    "  },",
    "  prepared",
    "}));"
  ].join("\n");
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    env: {
      ...process.env,
      LANG: expectedEnvironment,
      LC_ALL: expectedEnvironment,
      SIMFILE_TEST_LOCALE: locale,
      SIMFILE_TEST_LOCALE_ENV: expectedEnvironment
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  const [stdout, stderr, close] = await Promise.all([
    readStreamText(child.stdout),
    readStreamText(child.stderr),
    closePromise
  ]);
  if (close.signal !== null) throw new Error(`child terminated with signal ${String(close.signal)}: ${stderr}`);
  if (close.code !== 0) throw new Error(`child exited with code ${close.code}: ${stderr}`);
  try {
    const payload = JSON.parse(stdout) as {
      childPid?: number;
      requestedLocale?: LocaleProcessLocale;
      resolvedLocale?: string;
      controlOrder?: readonly string[];
      localeEnvironment?: { lang?: string; lcAll?: string };
      prepared?: PreparedBuild;
    };
    if (
      typeof payload.childPid !== "number" ||
      payload.requestedLocale !== locale ||
      typeof payload.resolvedLocale !== "string" ||
      !Array.isArray(payload.controlOrder) ||
      payload.controlOrder.length !== 2 ||
      typeof payload.prepared?.artifactBytes?.length !== "number" ||
      typeof payload.localeEnvironment?.lang !== "string" ||
      typeof payload.localeEnvironment?.lcAll !== "string"
    ) {
      throw new Error("malformed child payload");
    }
    return {
      childPid: payload.childPid,
      requestedLocale: payload.requestedLocale,
      resolvedLocale: payload.resolvedLocale,
      controlOrder: payload.controlOrder,
      prepared: payload.prepared,
      localeEnvironment: {
        lang: payload.localeEnvironment.lang,
        lcAll: payload.localeEnvironment.lcAll
      }
    };
  } catch (error) {
    throw new Error(`malformed child output: ${error instanceof Error ? error.message : String(error)}: ${stdout}`);
  }
};
