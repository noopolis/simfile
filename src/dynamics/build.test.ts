import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { prepareDynamicsBuild } from "./build.js";
import { createDynamicsClosureIdentity } from "./buildIdentity.js";
import { DYNAMICS_BUILD_CONTRACT, DYNAMICS_BUILD_PREPARATION_POLICY } from "./buildInput.js";
import { isDeclarationFile, isTransformableTypeScriptSource } from "./buildTypecheck.js";
import {
  artifactText,
  createBuildTestProject,
  prepareBuild,
  removeBuildTestPaths,
  writeBuildFile
} from "./buildTestSupport.test-helper.js";

describe("dynamics build preparation", () => {
  it("keeps the exact B11 literal deeply frozen", () => {
    assert.deepEqual(DYNAMICS_BUILD_CONTRACT, {
      allowedExtensions: [".ts", ".mjs"],
      typescript: { strict: true, noEmit: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" },
      esbuild: { platform: "node", format: "esm", target: "node22", bundle: true, sourcemap: false, legalComments: "none", charset: "utf8" }
    });
    assert.equal(Object.isFrozen(DYNAMICS_BUILD_CONTRACT), true);
    assert.equal(Object.isFrozen(DYNAMICS_BUILD_CONTRACT.allowedExtensions), true);
    assert.equal(Object.isFrozen(DYNAMICS_BUILD_CONTRACT.typescript), true);
    assert.equal(Object.isFrozen(DYNAMICS_BUILD_CONTRACT.esbuild), true);
    assert.throws(() => (DYNAMICS_BUILD_CONTRACT.allowedExtensions as unknown as string[]).push(".js"), TypeError);
  });

  it("uses a separate, frozen preparation policy in closure identity", () => {
    assert.equal(Object.isFrozen(DYNAMICS_BUILD_PREPARATION_POLICY), true);
    assert.equal(Object.isFrozen(DYNAMICS_BUILD_PREPARATION_POLICY.esbuild), true);
    assert.equal(Object.isFrozen(DYNAMICS_BUILD_PREPARATION_POLICY.esbuild.onLoadTranspile), true);
    assert.equal(Object.isFrozen(DYNAMICS_BUILD_PREPARATION_POLICY.package), true);
    assert.equal(Object.isFrozen(DYNAMICS_BUILD_PREPARATION_POLICY.source), true);
    assert.equal(Object.isFrozen(DYNAMICS_BUILD_PREPARATION_POLICY.source.declarationExtensions), true);
    assert.equal(Object.isFrozen(DYNAMICS_BUILD_PREPARATION_POLICY.source.checkedExtensions), true);
    assert.equal(Object.isFrozen(DYNAMICS_BUILD_PREPARATION_POLICY.source.javaScriptSyntaxExtensions), true);
    assert.equal(Object.isFrozen(DYNAMICS_BUILD_PREPARATION_POLICY.source.rejectRuntimeTypeExtensions), true);
    assert.equal(Object.isFrozen(DYNAMICS_BUILD_PREPARATION_POLICY.source.transformExtensions), true);
    assert.equal(Object.isFrozen(DYNAMICS_BUILD_PREPARATION_POLICY.simfileDynamics), true);
    assert.equal(Object.isFrozen(DYNAMICS_BUILD_PREPARATION_POLICY.simfileDynamics.acceptedErasedForms), true);
    assert.equal(Object.isFrozen(DYNAMICS_BUILD_PREPARATION_POLICY.simfileDynamics.runtimeCallForms), true);
    assert.equal(Object.isFrozen(DYNAMICS_BUILD_PREPARATION_POLICY.simfileDynamics.runtimeExpressionUnwrap), true);
    assert.equal(Object.isFrozen(DYNAMICS_BUILD_PREPARATION_POLICY.suppression), true);
    assert.equal(Object.isFrozen(DYNAMICS_BUILD_PREPARATION_POLICY.suppression.commentKinds), true);
    assert.equal(Object.isFrozen(DYNAMICS_BUILD_PREPARATION_POLICY.suppression.fullLineDirectives), true);
    assert.equal(Object.isFrozen(DYNAMICS_BUILD_PREPARATION_POLICY.nodeBuiltins), true);
    assert.equal(Object.isFrozen(DYNAMICS_BUILD_PREPARATION_POLICY.typescript), true);
    assert.equal(Object.isFrozen(DYNAMICS_BUILD_PREPARATION_POLICY.typescript.compilerOptions), true);
    assert.equal(Object.isFrozen(DYNAMICS_BUILD_PREPARATION_POLICY.typescript.types), true);
    assert.throws(() => (DYNAMICS_BUILD_PREPARATION_POLICY.nodeBuiltins as unknown as string[]).push("node:fs"), TypeError);
    const base = {
      buildContract: DYNAMICS_BUILD_CONTRACT,
      entry: "./systems/provider.mjs",
      esbuildVersion: "1",
      inputs: [],
      preparationPolicy: DYNAMICS_BUILD_PREPARATION_POLICY,
      typecheckMode: "none" as const,
      typescriptVersion: "1",
      usedNodeBuiltins: []
    };
    assert.notEqual(
      createDynamicsClosureIdentity(base).sha256,
      createDynamicsClosureIdentity({ ...base, preparationPolicy: { ...DYNAMICS_BUILD_PREPARATION_POLICY, esbuild: { ignoreAnnotations: false } } }).sha256
    );
    assert.notEqual(
      createDynamicsClosureIdentity(base).sha256,
      createDynamicsClosureIdentity({
        ...base,
        preparationPolicy: {
          ...DYNAMICS_BUILD_PREPARATION_POLICY,
          esbuild: {
            ...DYNAMICS_BUILD_PREPARATION_POLICY.esbuild,
            onLoadTranspile: { ...DYNAMICS_BUILD_PREPARATION_POLICY.esbuild.onLoadTranspile, target: "ES2019" as const }
          },
          nodeBuiltins: [...DYNAMICS_BUILD_PREPARATION_POLICY.nodeBuiltins, "node:fs"] as const,
          package: { ...DYNAMICS_BUILD_PREPARATION_POLICY.package, versionPattern: "^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)$" as const },
          source: {
            ...DYNAMICS_BUILD_PREPARATION_POLICY.source,
            transformExtensions: [".ts", ".tsx", ".mts", ".cts"] as const,
            rejectRuntimeTypeExtensions: [".ts"] as const
          },
          suppression: { ...DYNAMICS_BUILD_PREPARATION_POLICY.suppression, fullLineDirectives: ["ignore", "expect-error", "nocheck"] as const },
          typescript: { ...DYNAMICS_BUILD_PREPARATION_POLICY.typescript, checkJs: false },
          simfileDynamics: { ...DYNAMICS_BUILD_PREPARATION_POLICY.simfileDynamics, runtimeResolutionFailure: "type-only surface only" }
        }
      }).sha256
    );
    for (const typescript of [
      { ...DYNAMICS_BUILD_PREPARATION_POLICY.typescript, typeRootPackage: "@types/other" as const },
      { ...DYNAMICS_BUILD_PREPARATION_POLICY.typescript, typeRootResolution: "other" as const },
      { ...DYNAMICS_BUILD_PREPARATION_POLICY.typescript, types: ["node", "other"] as const }
    ]) {
      assert.notEqual(
        createDynamicsClosureIdentity(base).sha256,
        createDynamicsClosureIdentity({
          ...base,
          preparationPolicy: { ...DYNAMICS_BUILD_PREPARATION_POLICY, typescript }
        }).sha256
      );
    }
    for (const preparationPolicy of [
      {
        ...DYNAMICS_BUILD_PREPARATION_POLICY,
        package: { ...DYNAMICS_BUILD_PREPARATION_POLICY.package, nodeModulesDirectory: "vendor" }
      },
      {
        ...DYNAMICS_BUILD_PREPARATION_POLICY,
        package: { ...DYNAMICS_BUILD_PREPARATION_POLICY.package, scopePrefix: "!" }
      },
      {
        ...DYNAMICS_BUILD_PREPARATION_POLICY,
        source: { ...DYNAMICS_BUILD_PREPARATION_POLICY.source, javaScriptSyntaxExtensions: [".js"] }
      },
      {
        ...DYNAMICS_BUILD_PREPARATION_POLICY,
        suppression: { ...DYNAMICS_BUILD_PREPARATION_POLICY.suppression, directivePrefix: "@check-" }
      },
      {
        ...DYNAMICS_BUILD_PREPARATION_POLICY,
        suppression: { ...DYNAMICS_BUILD_PREPARATION_POLICY.suppression, placement: "anywhere" }
      },
      {
        ...DYNAMICS_BUILD_PREPARATION_POLICY,
        simfileDynamics: { ...DYNAMICS_BUILD_PREPARATION_POLICY.simfileDynamics, acceptedErasedForms: ["import-type"] }
      },
      {
        ...DYNAMICS_BUILD_PREPARATION_POLICY,
        simfileDynamics: { ...DYNAMICS_BUILD_PREPARATION_POLICY.simfileDynamics, runtimeCallForms: ["dynamic-import"] }
      },
      {
        ...DYNAMICS_BUILD_PREPARATION_POLICY,
        simfileDynamics: { ...DYNAMICS_BUILD_PREPARATION_POLICY.simfileDynamics, runtimeExpressionUnwrap: ["parenthesized"] }
      }
    ]) {
      assert.notEqual(
        createDynamicsClosureIdentity(base).sha256,
        createDynamicsClosureIdentity({ ...base, preparationPolicy }).sha256
      );
    }
  });

  it("never classifies declaration files as runtime transform inputs", () => {
    for (const fileName of ["types.d.ts", "types.d.mts", "types.d.cts"]) {
      assert.equal(isDeclarationFile(fileName), true);
      assert.equal(isTransformableTypeScriptSource(fileName), false);
    }
    assert.equal(isTransformableTypeScriptSource("provider.ts"), true);
    assert.equal(isTransformableTypeScriptSource("provider.mjs"), true);
  });

  it("prepares repeatable .mjs and .ts artifacts without evaluating authored code", async () => {
    const project = await createBuildTestProject();
    const marker = `${project.directory}/executed`;
    try {
      await writeBuildFile(project, "systems/provider.mjs", `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'top'); export const create = () => writeFileSync(${JSON.stringify(marker)}, 'factory');`);
      await assert.rejects(prepareBuild(project), /unsupported external import: node:fs/u);
      await assert.rejects(readFile(marker));
      await writeBuildFile(project, "systems/provider.mjs", "export const value = 1;\n");
      await writeBuildFile(project, "systems/provider.ts", "import type { DynamicsJsonValue } from 'simfile/dynamics'; export const value: DynamicsJsonValue = 1;\n");
      const mjs = await prepareBuild(project);
      const ts = await prepareBuild(project, "./systems/provider.ts");
      assert.deepEqual(mjs.artifactBytes, (await prepareBuild(project)).artifactBytes);
      assert.equal(ts.typecheckMode, "typescript");
      assert.match(artifactText(ts), /closure-sha256/u);
      assert.doesNotMatch(artifactText(ts), /simfile\/dynamics/u);
    } finally {
      await removeBuildTestPaths(project.directory);
    }
  });

  it("rejects runtime imports of the Simfile type surface", async () => {
    const project = await createBuildTestProject();
    try {
      await writeBuildFile(project, "systems/provider.ts", "import { DYNAMICS_LIMITS } from 'simfile/dynamics'; export const value = DYNAMICS_LIMITS;\n");
      await assert.rejects(prepareBuild(project, "./systems/provider.ts"), /erased type-only/u);
    } finally {
      await removeBuildTestPaths(project.directory);
    }
  });

  it("permits every erased type-only form and rejects runtime type-surface forms", async () => {
    const project = await createBuildTestProject();
    try {
      await writeBuildFile(project, "systems/provider.ts", [
        "import type { DynamicsJsonValue } from 'simfile/dynamics';",
        "import type * as Dynamics from 'simfile/dynamics';",
        "import { type DynamicsProvider } from 'simfile/dynamics';",
        "export type { DynamicsJsonValue } from 'simfile/dynamics';",
        "export { type DynamicsProvider } from 'simfile/dynamics';",
        "export type * from 'simfile/dynamics';",
        "import type {} from 'simfile/dynamics';",
        "export type {} from 'simfile/dynamics';",
        "type Imported = import('simfile/dynamics').DynamicsJsonValue | Dynamics.DynamicsJsonValue;",
        "export const value: Imported = 1;"
      ].join("\n"));
      const erased = await prepareBuild(project, "./systems/provider.ts");
      assert.doesNotMatch(artifactText(erased), /simfile\/dynamics/u);
      const shadow = { directory: `${project.directory}/node_modules/simfile` };
      await writeBuildFile(shadow, "package.json", JSON.stringify({ name: "simfile", version: "1.0.0", type: "module", exports: { "./dynamics": "./dynamics.mjs" } }));
      await writeBuildFile(shadow, "dynamics.mjs", "export const value = 1;\n");
      const runtimeForms = [
        "import 'simfile/dynamics'; export const value = 1;",
        "import value from 'simfile/dynamics'; export { value };",
        "import * as value from 'simfile/dynamics'; export { value };",
        "import { value } from 'simfile/dynamics'; export { value };",
        "export { value } from 'simfile/dynamics';",
        "export * from 'simfile/dynamics';",
        "export * as value from 'simfile/dynamics';",
        "import value = require('simfile/dynamics'); export { value };",
        "export const value = import('simfile/dynamics');",
        "export const value = require('simfile/dynamics');"
      ];
      for (const source of runtimeForms) {
        await writeBuildFile(project, "systems/provider.ts", source);
        await assert.rejects(prepareBuild(project, "./systems/provider.ts"), /erased type-only/u);
      }
      await writeBuildFile(project, "systems/provider.mjs", "export const value = import('simfile/dynamics');\n");
      await assert.rejects(prepareBuild(project), /erased type-only/u);
    } finally {
      await removeBuildTestPaths(project.directory);
    }
  });

  it("erases type import-equals and rejects empty, mixed, and indirect runtime surface forms", async () => {
    const project = await createBuildTestProject();
    try {
      const source = "import type Dynamics = require('simfile/dynamics'); export const value: Dynamics.DynamicsJsonValue = 1;";
      await writeBuildFile(project, "systems/provider.ts", source);
      const before = await prepareBuild(project, "./systems/provider.ts");
      const shadow = { directory: `${project.directory}/node_modules/simfile` };
      await writeBuildFile(shadow, "package.json", JSON.stringify({ name: "simfile", version: "1.0.0", type: "module", exports: { "./dynamics": "./dynamics.mjs" } }));
      await writeBuildFile(shadow, "dynamics.mjs", "export const value = 1;\n");
      const after = await prepareBuild(project, "./systems/provider.ts");
      assert.deepEqual(after.artifactBytes, before.artifactBytes);
      assert.doesNotMatch(artifactText(after), /simfile\/dynamics/u);
      for (const runtime of [
        "import {} from 'simfile/dynamics'; export const value = 1;",
        "export {} from 'simfile/dynamics'; export const value = 1;",
        "import value, { type DynamicsJsonValue } from 'simfile/dynamics'; export { value };",
        "export const value = import('simfile/dynamics', {});",
        "export const value = (require)('simfile/dynamics');",
        "export const value = (0, require)('simfile/dynamics');",
        "export const value = require.call(null, 'simfile/dynamics');",
        "export const value = require?.('simfile/dynamics');"
      ]) {
        await writeBuildFile(project, "systems/provider.ts", runtime);
        await assert.rejects(prepareBuild(project, "./systems/provider.ts"), /erased type-only/u);
      }
    } finally { await removeBuildTestPaths(project.directory); }
  });

  it("permits erased empty type import/export forms while rejecting runtime equivalents", async () => {
    const project = await createBuildTestProject();
    try {
      for (const source of [
        "import type {} from 'simfile/dynamics';\nexport const value = 1;",
        "export type {} from 'simfile/dynamics';\nexport const value = 1;"
      ]) {
        await writeBuildFile(project, "systems/provider.ts", source);
        const prepared = await prepareBuild(project, "./systems/provider.ts");
        assert.doesNotMatch(artifactText(prepared), /simfile\/dynamics/u);
      }
      for (const source of [
        "import {} from 'simfile/dynamics';\nexport const value = 1;",
        "export {} from 'simfile/dynamics';\nexport const value = 1;"
      ]) {
        await writeBuildFile(project, "systems/provider.ts", source);
        await assert.rejects(prepareBuild(project, "./systems/provider.ts"), /erased type-only/u);
      }
    } finally { await removeBuildTestPaths(project.directory); }
  });

  it("returns deeply immutable portable results", async () => {
    const project = await createBuildTestProject();
    try {
      await writeBuildFile(project, "systems/provider.mjs", "export const value = 1;\n");
      const prepared = await prepareDynamicsBuild(project.simfilePath, "./systems/provider.mjs");
      assert.equal(Object.isFrozen(prepared), true);
      assert.equal(Object.isFrozen(prepared.artifactBytes), true);
      assert.equal(Object.isFrozen(prepared.inputs), true);
      assert.equal(Object.isFrozen(prepared.closureDescriptor), true);
      assert.throws(() => (prepared.artifactBytes as number[])[0] = 0, TypeError);
      assert.doesNotMatch(JSON.stringify(prepared), new RegExp(project.directory.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    } finally {
      await removeBuildTestPaths(project.directory);
    }
  });
});
