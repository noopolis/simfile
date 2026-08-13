import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  assertNoFilesystemPathLeaks,
  artifactText,
  collectStringValues,
  assertAxisMutationHeaderEffect,
  makePackage,
  assertPreparedSingleInputMutation,
  closureHeader,
  buildShapeFromPrepared,
  createBuildTestProject,
  runAxisMutationFixture,
  runPreparedSingleInputMutationFixture,
  assertUnreachableFileMutationNoEffect,
  LocaleChildResult,
  LocaleProcessLocale,
  prepareBuild,
  prepareBuildInLocaleChild,
  PreparedBuild,
  removeBuildTestPaths,
  writeBuildFile
} from "./buildTestSupport.test-helper.js";
import {
  compareUtf16,
  createDynamicsClosureIdentity,
  type DynamicsBuildInputDescriptor
} from "./buildIdentity.js";
import { DYNAMICS_BUILD_PREPARATION_POLICY } from "./buildInput.js";
import { DYNAMICS_STATIC_CLOSURE_POLICY } from "./buildStaticPolicy.js";
import { assertStaticEmittedEsm } from "./buildStaticPolicy.js";

type UnknownRecord = Readonly<Record<string, unknown>>;

const localeControls = ["ä", "z"] as const;
const expectedLocaleEnvironment: Record<LocaleProcessLocale, string> = {
  "en-US": "en_US.UTF-8",
  "sv-SE": "sv_SE.UTF-8"
};
const expectedLocaleSort: Record<LocaleProcessLocale, readonly string[]> = {
  "en-US": ["ä", "z"],
  "sv-SE": ["z", "ä"]
};
const expectedPolicy = {
  ...DYNAMICS_BUILD_PREPARATION_POLICY,
  staticClosure: DYNAMICS_STATIC_CLOSURE_POLICY
} as const;
const INPUT_MUTATION_KEYS = {
  commentSource: "project:./systems/provider.mjs",
  typesSource: "project:./systems/types.ts",
  packageSource: "package:identity-pkg:./index.mjs",
  manifestVersion: "package:identity-pkg:./index.mjs"
} as const;
const PROJECT_KEYS = ["kind", "modes", "path", "sha256"] as const;
const PACKAGE_KEYS = ["kind", "manifest_sha256", "modes", "package_name", "package_path", "package_version", "sha256"] as const;
const TYPE_ONLY_KEYS = ["files", "kind", "manifest_sha256", "package_name", "package_version", "surface"] as const;

type Prepared = PreparedBuild;
const asRecord = (value: unknown): UnknownRecord =>
  (value && typeof value === "object" && !Array.isArray(value)) ? value as UnknownRecord : {};
const asStrings = (value: unknown): readonly string[] => Array.isArray(value)
  ? value.filter((entry): entry is string => typeof entry === "string")
  : [];
const asDescriptors = (value: unknown): readonly DynamicsBuildInputDescriptor[] => Array.isArray(value)
  ? value.filter((entry): entry is DynamicsBuildInputDescriptor => typeof entry === "object" && entry !== null)
  : [];
const sortByPath = <Entry extends { readonly path: string }>(entries: readonly Entry[]): readonly Entry[] =>
  [...entries].sort((left: Entry, right: Entry): number => compareUtf16(left.path, right.path));

const makeLocaleFixture = async (directory: string): Promise<void> => {
  await writeBuildFile({ directory }, "systems/ä.mjs", "export const a = 1;\n");
  await writeBuildFile({ directory }, "systems/z.mjs", "export const z = 2;\n");
  await writeBuildFile({ directory }, "systems/provider.mjs", "import { a } from './ä.mjs';\nimport { z } from './z.mjs';\nexport const value = a + z;\n");
};


const freezeRecursively = (value: unknown): void => {
  if (!value || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value as Record<string, unknown>)) freezeRecursively(child);
};

const assertCanonicalDescriptorKeys = (value: unknown, parentKey?: string, skipSorted = false): void => {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const child of value) assertCanonicalDescriptorKeys(child, undefined, skipSorted);
    return;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const isPolicyOrContract = parentKey === "preparation_policy" || parentKey === "build_contract";
  if (!skipSorted && !isPolicyOrContract) {
    assert.deepEqual(keys, [...keys].sort(compareUtf16));
  }
  const childSkipSorted = skipSorted || isPolicyOrContract;
  for (const key of keys) assertCanonicalDescriptorKeys(record[key], key, childSkipSorted);
};

const assertLocaleResult = (result: LocaleChildResult, locale: LocaleProcessLocale): void => {
  assert.equal(result.requestedLocale, locale);
  assert.equal(result.localeEnvironment.lang, expectedLocaleEnvironment[locale]);
  assert.equal(result.localeEnvironment.lcAll, expectedLocaleEnvironment[locale]);
  assert.equal(result.resolvedLocale.toLowerCase().startsWith(locale.toLowerCase()), true);
  assert.deepEqual(result.controlOrder, expectedLocaleSort[locale]);
  assert.deepEqual([...localeControls].sort((left, right) => new Intl.Collator(result.resolvedLocale, { sensitivity: "variant" }).compare(left, right)), expectedLocaleSort[locale]);
};

const assertPreparedShape = (prepared: Prepared): void => {
  for (const input of prepared.inputs) {
    if (input.kind === "project") {
      assert.deepEqual(Object.keys(input), PROJECT_KEYS);
      assert.equal(input.path.startsWith("./"), true);
      assert.deepEqual(input.modes, [...input.modes].sort(compareUtf16));
      assert.equal(path.isAbsolute(input.path), false);
    } else if (input.kind === "package") {
      assert.deepEqual(Object.keys(input), PACKAGE_KEYS);
      assert.equal(input.package_path.startsWith("./"), true);
      assert.deepEqual(input.modes, [...input.modes].sort(compareUtf16));
      assert.equal(path.isAbsolute(input.package_path), false);
    } else {
      assert.deepEqual(Object.keys(input), TYPE_ONLY_KEYS);
      assert.equal(input.surface, "dynamics");
      assert.deepEqual(input.files, sortByPath(input.files));
      for (const file of input.files) assert.equal(path.isAbsolute(file.path), false);
    }
  }
  assert.deepEqual(Object.keys(prepared.closureDescriptor), [...Object.keys(prepared.closureDescriptor)].sort(compareUtf16));
  assertCanonicalDescriptorKeys(prepared.closureDescriptor);
  assert.deepEqual(
    prepared.inputs,
    [...prepared.inputs].sort((left, right) =>
      compareUtf16(JSON.stringify(left), JSON.stringify(right)))
  );
};

const assertNoLeakInPaths = (prepared: Prepared, projectDirectory: string): void => {
  assertNoFilesystemPathLeaks(prepared, projectDirectory);
  const roots = [path.resolve(projectDirectory), path.resolve(path.dirname(projectDirectory))];
  const seen = [...collectStringValues(prepared), artifactText(prepared)];
  for (const value of seen) {
    for (const root of roots) assert.equal(value.includes(root), false);
  }
};

const assertPairwisePreparedMatch = (prepareds: readonly Prepared[]): void => {
  const [first, ...rest] = prepareds;
  for (const prepared of rest) {
    assert.deepEqual(first, prepared);
    assert.deepEqual(closureHeader(first), closureHeader(prepared));
    assert.deepEqual(first.closureDescriptor, prepared.closureDescriptor);
    assert.deepEqual(first.artifactBytes, prepared.artifactBytes);
  }
};

const expectedPreparedPolicyText = JSON.stringify(expectedPolicy);

describe("dynamics build determinism proof matrix", () => {
  it("forces locale-sensitive child-process builds across two absolute roots", async () => {
    const rootOne = await mkdtemp(path.join(os.tmpdir(), "simfile-locale-one-"));
    const rootTwo = await mkdtemp(path.join(os.tmpdir(), "simfile-locale-two-"));
    try {
      const projectOne = await createBuildTestProject(rootOne);
      const projectTwo = await createBuildTestProject(rootTwo);
      await makeLocaleFixture(projectOne.directory);
      await makeLocaleFixture(projectTwo.directory);
      const children = await Promise.all([
        prepareBuildInLocaleChild(projectOne.directory, "en-US"),
        prepareBuildInLocaleChild(projectOne.directory, "sv-SE"),
        prepareBuildInLocaleChild(projectTwo.directory, "en-US"),
        prepareBuildInLocaleChild(projectTwo.directory, "sv-SE")
      ]);
      assert.equal(new Set(children.map((entry) => entry.childPid)).size, 4);
      const [enOne, svOne, enTwo, svTwo] = children;
      assertLocaleResult(enOne, "en-US");
      assertLocaleResult(svOne, "sv-SE");
      assertLocaleResult(enTwo, "en-US");
      assertLocaleResult(svTwo, "sv-SE");
      assert.notDeepEqual(enOne.controlOrder, svOne.controlOrder);
      assert.notDeepEqual(enTwo.controlOrder, svTwo.controlOrder);
      assertPairwisePreparedMatch(children.map((entry) => entry.prepared));
      const checked: ReadonlyArray<[LocaleChildResult, string]> = [
        [enOne, projectOne.directory],
        [svOne, projectOne.directory],
        [enTwo, projectTwo.directory],
        [svTwo, projectTwo.directory]
      ];
      for (const [child, fixtureRoot] of checked) {
        const names = new Set(child.prepared.inputs.filter((input): input is Extract<DynamicsBuildInputDescriptor, { kind: "project" }> => input.kind === "project").map((entry) => entry.path));
        assert.equal(names.has("./systems/ä.mjs"), true);
        assert.equal(names.has("./systems/z.mjs"), true);
        assert.equal(names.has("./systems/provider.mjs"), true);
        assertPreparedShape(child.prepared);
        assertNoFilesystemPathLeaks(child.prepared, fixtureRoot);
      }
    } finally {
      await removeBuildTestPaths(rootOne, rootTwo);
    }
  });

  it("keeps locale and comment sensitivity for source", async () => {
    await runPreparedSingleInputMutationFixture(
      (project) => writeBuildFile(project, "systems/provider.mjs", "// base\nexport const value = 1;\n"),
      async (project) => {
        await writeBuildFile(project, "systems/provider.mjs", "// changed\nexport const value = 1;\n");
        return prepareBuild(project);
      },
      INPUT_MUTATION_KEYS.commentSource
    );
  });

  it("keeps type-only sensitivity", async () => {
    await runPreparedSingleInputMutationFixture(
      (project) => Promise.all([
        writeBuildFile(project, "systems/provider.ts", "import type { Marker } from './types.ts';\nexport const value: Marker = 'ok';\n"),
        writeBuildFile(project, "systems/types.ts", "export type Marker = string;\n")
      ]),
      async (project) => {
        await writeBuildFile(project, "systems/types.ts", "export type Marker = string | number;\n");
        return prepareBuild(project, "./systems/provider.ts");
      },
      INPUT_MUTATION_KEYS.typesSource,
      "./systems/provider.ts"
    );
  });

  it("keeps package-source sensitivity", async () => {
    await runPreparedSingleInputMutationFixture(
      async (project) => {
        await makePackage(project.directory, "identity-pkg", "1.0.0", "export const value = 1;\n");
        await writeBuildFile(project, "systems/provider.mjs", "import { value } from 'identity-pkg';\nexport const output = value;\n");
      },
      async (project) => {
        await writeBuildFile({ directory: path.join(project.directory, "node_modules", "identity-pkg") }, "index.mjs", "export const value = 2;\n");
        return prepareBuild(project);
      },
      INPUT_MUTATION_KEYS.packageSource
    );
  });

  it("keeps manifest-version sensitivity", async () => {
    const rootOne = await mkdtemp(path.join(os.tmpdir(), "simfile-manifest-root-"));
    const rootTwo = await mkdtemp(path.join(os.tmpdir(), "simfile-manifest-root-"));
    try {
      const makeProject = async (parent: string, version: string): Promise<Prepared> => {
        const project = await createBuildTestProject(parent);
        await makePackage(project.directory, "identity-pkg", version, "export const value = 1;\n");
        await writeBuildFile(project, "systems/provider.mjs", "import { value } from 'identity-pkg';\nexport const output = value;\n");
        return prepareBuild(project);
      };
      const baseline = await makeProject(rootOne, "1.0.0");
      const mutated = await makeProject(rootTwo, "1.0.1");
      assertPreparedSingleInputMutation({
        baseline,
        mutated,
        expectedChangedInputKey: INPUT_MUTATION_KEYS.manifestVersion
      });
    } finally {
      await removeBuildTestPaths(rootOne, rootTwo);
    }
  });

  it("proves fixed preparation and static policy axis", async () => {
    await runAxisMutationFixture((shape) => {
      const prep = asRecord(shape.preparationPolicy);
      const staticClosure = asRecord(prep.staticClosure);
      const source = asRecord(staticClosure.source);
      return createDynamicsClosureIdentity({
        ...shape,
        preparationPolicy: {
          ...prep,
          staticClosure: { ...staticClosure, source: { ...source, scriptTarget: "ES2015" } }
        }
      });
    });
  });

  it("proves esbuild version axis", async () => {
    await runAxisMutationFixture((shape) => createDynamicsClosureIdentity({
      ...shape,
      esbuildVersion: "0.0.0-tool"
    }));
  });

  it("proves TypeScript version axis", async () => {
    await runAxisMutationFixture((shape) => createDynamicsClosureIdentity({
      ...shape,
      typescriptVersion: "9.9.9-tool"
    }));
  });

  it("proves approved builtin policy axis", async () => {
    await runAxisMutationFixture((shape) => createDynamicsClosureIdentity({
      ...shape,
      preparationPolicy: {
        ...shape.preparationPolicy,
        nodeBuiltins: [...asStrings(shape.preparationPolicy.nodeBuiltins), "node:fs"]
      }
    }));
  });

  it("proves used builtin subset axis", async () => {
    await runAxisMutationFixture((shape) => createDynamicsClosureIdentity({
      ...shape,
      usedNodeBuiltins: ["node:crypto"]
    }));
  });

  it("proves typecheck mode axis", async () => {
    await runAxisMutationFixture((shape) => createDynamicsClosureIdentity({
      ...shape,
      typecheckMode: shape.typecheckMode === "none" ? "typescript" : "none"
    }));
  });

  it("does not change prepared result from unreachable mutation", async () => {
    const project = await createBuildTestProject();
    try {
      await assertUnreachableFileMutationNoEffect(project);
    } finally {
      await removeBuildTestPaths(project.directory);
    }
  });

  it("keeps complex accepted result frozen and root-safe with retained node builtin", async () => {
    const project = await createBuildTestProject();
    try {
      await makePackage(project.directory, "complex-pkg", "1.0.0", "export const value = 2;\n");
      await writeBuildFile(
        project,
        "systems/provider.ts",
        [
          "import type { DynamicsJsonValue } from 'simfile/dynamics';",
          "import { randomUUID } from 'node:crypto';",
          "import { value } from 'complex-pkg';",
          "export const marker: DynamicsJsonValue = { value };",
          "export const randomSeed = randomUUID;"
        ].join("\n")
      );
      const prepared = await prepareBuild(project, "./systems/provider.ts");
      freezeRecursively(prepared);
      assertPreparedShape(prepared);
      assertNoLeakInPaths(prepared, project.directory);
      assert.equal(JSON.stringify(asRecord(prepared.closureDescriptor.preparation_policy)), expectedPreparedPolicyText);
      assert.deepEqual(prepared.nodeExternals, ["node:crypto"]);
      assert.deepEqual(asStrings(asRecord(prepared.closureDescriptor).used_node_builtins), ["node:crypto"]);
      const artifact = artifactText(prepared);
      assert.doesNotMatch(artifact, /globalThis|require\(|createRequire\(/u);
      assertStaticEmittedEsm("dynamics.mjs", artifact);
      const hasControl = [path.resolve(project.directory), path.resolve(path.dirname(project.directory))];
      for (const p of [...collectStringValues(prepared), artifact]) {
        for (const root of hasControl) {
          assert.equal(p.includes(root), false);
        }
      }
    } finally {
      await removeBuildTestPaths(project.directory);
    }
  });

  it("proves recursive closure-identity invariance with locale-sensitive keys", async () => {
    const project = await createBuildTestProject();
    try {
      await writeBuildFile(project, "systems/provider.ts", "export const value = 1;\n");
      const baseline = await prepareBuild(project, "./systems/provider.ts");
      const shape = buildShapeFromPrepared(baseline);
      const one = createDynamicsClosureIdentity({ ...shape, buildContract: { ...shape.buildContract, localeBucket: { z: 1, ä: 2 } } });
      const two = createDynamicsClosureIdentity({ ...shape, buildContract: { ...shape.buildContract, localeBucket: { ä: 2, z: 1 } } });
      assert.equal(one.sha256, two.sha256);
      assert.equal(one.header, two.header);
      assert.deepEqual(one.descriptor, two.descriptor);
      assert.deepEqual(one, two);
      const oneInputs = asDescriptors(one.descriptor.inputs as unknown);
      const twoInputs = asDescriptors(two.descriptor.inputs as unknown);
      const onePolicy = asRecord(one.descriptor.preparation_policy);
      const twoPolicy = asRecord(two.descriptor.preparation_policy);
      assert.deepEqual(oneInputs, twoInputs);
      assert.deepEqual(onePolicy, twoPolicy);
      assertCanonicalDescriptorKeys(one.descriptor);
      for (let index = 0; index < oneInputs.length; index += 1) {
        const left = oneInputs[index];
        const right = twoInputs[index];
        if (left.kind === "type-only") {
          assert.equal(right.kind, "type-only");
          assert.deepEqual(sortByPath(left.files), right.kind === "type-only" ? sortByPath(right.files) : []);
        } else {
          assert.equal(right.kind, left.kind);
          assert.deepEqual(left.modes, right.modes);
        }
      }
    } finally {
      await removeBuildTestPaths(project.directory);
    }
  });
});
