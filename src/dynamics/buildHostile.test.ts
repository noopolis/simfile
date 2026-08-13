import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, unlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  artifactText,
  createBuildTestProject,
  prepareBuild,
  removeBuildTestPaths,
  writeBuildFile
} from "./buildTestSupport.test-helper.js";

const marker = "__SIMFILE_B54_HOSTILE_MARKER__";
const withMarker = (source: string): string => `${source}\nglobalThis.${marker} = true;`;
const clearMarker = (): void => {
  delete (globalThis as Record<string, unknown>)[marker];
};
const assertMarkerAbsent = (): void => {
  assert.equal((globalThis as Record<string, unknown>)[marker], undefined);
};

const addPackage = async (
  directory: string,
  name: string,
  version: string,
  source: string,
  type: "module" | "commonjs" = "module"
): Promise<void> => {
  await mkdir(directory, { recursive: true });
  const entry = type === "commonjs" ? "index.cjs" : "index.mjs";
  await writeBuildFile({ directory }, "package.json", JSON.stringify({ name, version, type, main: `./${entry}` }));
  await writeBuildFile({ directory }, entry, source);
};

const assertHostileSource = async (
  project: Parameters<typeof prepareBuild>[0],
  source: string,
  expected: RegExp
): Promise<void> => {
  clearMarker();
  await writeBuildFile(project, "systems/provider.mjs", withMarker(source));
  await assert.rejects(prepareBuild(project), expected);
  assertMarkerAbsent();
};

describe("dynamics build hostile boundary probes", () => {
  it("rejects entry, transitive, and package symlink escapes", async () => {
    const project = await createBuildTestProject();
    try {
      await writeBuildFile(project, "systems/real-provider.mjs", withMarker("export const value = 1;\n"));
      await symlink(path.join(project.directory, "systems", "real-provider.mjs"), path.join(project.directory, "systems", "provider.mjs"));
      await assert.rejects(prepareBuild(project), /must not contain symlinks|dynamics\.module|static source path/u);
      assertMarkerAbsent();
      await unlink(path.join(project.directory, "systems", "provider.mjs"));

      await writeBuildFile(project, "systems/real-helper.mjs", "export const value = 2;\n");
      await symlink(path.join(project.directory, "systems", "real-helper.mjs"), path.join(project.directory, "systems", "link-helper.mjs"));
      await assertHostileSource(
        project,
        "import { value } from './link-helper.mjs';\nexport const output = value;\n",
        /static source path is not a regular file|must not contain symlinks|static source path/u
      );

      const packageDirectory = path.join(project.directory, "node_modules", "real-safe-pkg");
      const aliasDirectory = path.join(project.directory, "node_modules", "alias-safe-pkg");
      await addPackage(packageDirectory, "real-safe-pkg", "1.0.0", "export const value = 3;\n");
      await symlink(packageDirectory, aliasDirectory);
      await assertHostileSource(
        project,
        "import { value } from 'alias-safe-pkg';\nexport const output = value;\n",
        /static source path is not a regular file|s\.path is no longer contained|static source path|package manifest/u
      );
    } finally {
      clearMarker();
      await removeBuildTestPaths(project.directory);
    }
  });

  it("rejects boundary escapes, unresolved imports, URL/absolute, and non-file paths", async () => {
    const ancestor = await mkdtemp(path.join(os.tmpdir(), "simfile-b54-boundary-"));
    const project = await createBuildTestProject(path.join(ancestor, "project"));
    const packageOwner = path.join(ancestor, "node_modules", "owned-pkg");
    const packageProject = await createBuildTestProject(path.join(ancestor, "package-a"));

    try {
      await writeFile(path.join(ancestor, "package-a", "package.json"), JSON.stringify({ name: "package-a", version: "1.0.0", type: "module" }));
      await addPackage(path.join(ancestor, "node_modules", "sibling"), "sibling", "1.0.0", "export const value = 5;\n");
      await addPackage(path.join(ancestor, "package-a", "sibling"), "sibling", "1.0.0", "export const value = 5;\n");
      await writeFile(path.join(ancestor, "node_modules", "sibling", "index.d.mts"), "export declare const value: number;\n");
      await mkdir(path.join(project.directory, "systems", "not-a-file.mjs"), { recursive: true });
      await assert.rejects(prepareBuild(project, "./systems/not-a-file.mjs"), /static source path leaf is not a regular file|regular file/u);

      const fifoPath = path.join(project.directory, "systems", "fifo.mjs");
      if (process.platform !== "win32") {
        execFileSync("mkfifo", [fifoPath]);
        await assertHostileSource(project, "export { value } from './fifo.mjs';\n", /static source path leaf is not a regular file|static source path/u);
      }

      await addPackage(packageOwner, "owned-pkg", "1.0.0", "export const value = 4;\n");
      await assertHostileSource(
        project,
        "import { value } from '../../../node_modules/owned-pkg/index.mjs';\n",
        /relative import escape|outside|static source path|s\.path|dynamics TypeScript check failed|Cannot find module|TS2307|does not contain/u
      );

      await assertHostileSource(
        project,
        "import { value } from '../missing.mjs';\n",
        /outside|does not contain|static source|resolve|missing|TS2307|Cannot find module/u
      );

      await assertHostileSource(packageProject, "import { value } from '../../sibling/index.mjs'; export { value };\n", /relative import escape/u);
      await assertHostileSource(
        packageProject,
        "import 'missing-pkg';\n",
        /incomplete static resolution evidence: missing-pkg/u
      );

      for (const source of [
        "import 'https://example.test/x.mjs';\n",
        "import 'C:/tmp/outside.mjs';\n",
        "import '/tmp/outside.mjs';\n"
      ]) {
        await assertHostileSource(packageProject, source, /static source|url|unsupported|resolved|absolute|dynamics build|resolve/i);
      }
    } finally {
      clearMarker();
      await removeBuildTestPaths(ancestor);
    }
  });

  it("rejects malformed dynamic/import and require matrix defects", async () => {
    const project = await createBuildTestProject();
    try {
      await writeBuildFile(project, "systems/local.mjs", "export const value = 1;\n");
      await assertHostileSource(project, "import { value } from 'simfile/dynamics';\n", /erased type-only|static source/i);
      await assertHostileSource(project, "export const value = import('simfile/dynamics');\n", /erased type-only|static source/i);
      await assertHostileSource(project, "export const value = require('simfile/dynamics');\n", /erased type-only|static source/i);

      const malformedDynamic = [
        "import('package-name');\n",
        "import('node:crypto');\n",
        "import('https://example.test/x.mjs');\n",
        "import('/tmp/outside.mjs');\n",
        "import('./' + 'local.mjs');\n",
        "import('./local.mjs', { with: { type: 'json' } });\n"
      ];
      for (const source of malformedDynamic) {
        await assertHostileSource(project, source, /static source|dynamics build|unsupported|path/u);
      }

      const badRequire = [
        "const src = './local.mjs'; const x = src; require(x);\n",
        "const src = './local.mjs'; (require)(src);\n",
        "const src = './local.mjs'; ((require))(src);\n",
        "const src = './local.mjs'; (0, require)(src);\n",
        "const src = './local.mjs'; require.call(null, src);\n",
        "const src = './local.mjs'; const r = require; r(src);\n",
        "const src = './local.mjs'; const r = (0, require); r(src);\n"
      ];
      for (const source of badRequire) {
        await assertHostileSource(project, source, /static source|unsupported|dynamics build|erased type-only/i);
      }

      const legacyBuiltins = [
        "import 'crypto';\n",
        "import 'node:fs';\n",
        "import { value } from 'fs';\n",
        "export const value = import('fs');\n"
      ];
      for (const source of legacyBuiltins) {
        await assertHostileSource(project, source, /static source|unsupported|dynamics build/i);
      }
    } finally {
      clearMarker();
      await removeBuildTestPaths(project.directory);
    }
  });

  it("accepts transitive project/package closure with local dynamic import", async () => {
    const ancestor = await mkdtemp(path.join(os.tmpdir(), "simfile-b54-accept-"));
    const project = await createBuildTestProject(path.join(ancestor, "project"));

    try {
      await addPackage(path.join(ancestor, "node_modules", "enclosing-pkg"), "enclosing-pkg", "1.0.0", "export const enclosing = 11;\n");
      await addPackage(path.join(project.directory, "node_modules", "transitive-pkg"), "transitive-pkg", "1.0.0", "export const transitive = 3;\n");
      await addPackage(path.join(project.directory, "node_modules", "pkg"), "pkg", "1.0.0", "import { transitive } from 'transitive-pkg'; export const pkgValue = transitive + 1;\n");
      await writeBuildFile(project, "systems/local.mjs", "export const localValue = 1;\n");
      await writeBuildFile(
        project,
        "systems/provider.mjs",
        withMarker(
          "import { localValue } from './local.mjs';\n" +
          "import { pkgValue } from 'pkg';\n" +
          "import { enclosing } from 'enclosing-pkg';\n" +
          "export const value = import('./local.mjs').then(({ localValue }) => localValue + pkgValue + enclosing);\n"
        )
      );

      const prepared = await prepareBuild(project);
      assert.equal(prepared.nodeExternals.length, 0);
      assert.doesNotMatch(artifactText(prepared), /\bimport\s*\(/u);
      assert.equal(prepared.inputs.some((input) => input.kind === "project" && input.path === "./systems/local.mjs"), true);
      assert.equal(prepared.inputs.some((input) => input.kind === "package" && input.package_name === "pkg"), true);
      assert.equal(prepared.inputs.some((input) => input.kind === "package" && input.package_name === "transitive-pkg"), true);
      assert.equal(prepared.inputs.some((input) => input.kind === "package" && input.package_name === "enclosing-pkg"), true);
      assertMarkerAbsent();
    } finally {
      clearMarker();
      await removeBuildTestPaths(ancestor);
    }
  });

  it("accepts direct require, closed CJS, and exact builtin externals", async () => {
    const direct = await createBuildTestProject();
    const cjs = await createBuildTestProject();

    try {
      await writeBuildFile(direct, "systems/dep.mjs", "export const value = 4;\n");
      await writeBuildFile(direct, "systems/provider.mjs", withMarker("const dep = require('./dep.mjs');\nexport const value = dep.value;\n"));
      const directResult = await prepareBuild(direct);
      assert.deepEqual(directResult.nodeExternals, []);
      assertMarkerAbsent();

      await writeBuildFile(direct, "systems/provider.mjs", withMarker(
        "import { randomUUID } from 'node:crypto';\nimport { createHash } from 'node:crypto';\nexport const value = randomUUID() + createHash('sha256').digest('hex');\n"
      ));
      const cryptoOnce = await prepareBuild(direct);
      assert.deepEqual(cryptoOnce.nodeExternals, ["node:crypto"]);
      assertMarkerAbsent();

      await addPackage(path.join(cjs.directory, "node_modules", "closed-cjs"), "closed-cjs", "1.0.0", "exports.value = 9;", "commonjs");
      await writeBuildFile(cjs, "systems/provider.mjs", withMarker("import value from 'closed-cjs';\nexport const output = value.value;\n"));
      const closed = await prepareBuild(cjs);
      assert.equal(closed.nodeExternals.length, 0);
      assert.equal(closed.inputs.some((input) => input.kind === "package" && input.package_name === "closed-cjs"), true);
      assertMarkerAbsent();

      const empty = await createBuildTestProject();
      await writeBuildFile(empty, "systems/provider.mjs", withMarker("export const value = 1;\n"));
      const noBuiltin = await prepareBuild(empty);
      assert.deepEqual(noBuiltin.nodeExternals, []);
      assertMarkerAbsent();
      await removeBuildTestPaths(empty.directory);
    } finally {
      clearMarker();
      await removeBuildTestPaths(direct.directory, cjs.directory);
    }
  });

  it("rejects symlinked package ancestors and extensionless package entries before a read", async () => {
    const project = await createBuildTestProject();
    const modules = await mkdtemp(path.join(os.tmpdir(), "simfile-b54-modules-"));
    try {
      await addPackage(path.join(modules, "ancestor-pkg"), "ancestor-pkg", "1.0.0", "export const value = 1;\n");
      await symlink(modules, path.join(project.directory, "node_modules"));
      await assertHostileSource(project, "import { value } from 'ancestor-pkg'; export { value };\n", /static source path is not regular/u);
      await unlink(path.join(project.directory, "node_modules"));

      const packageDirectory = path.join(project.directory, "node_modules", "extensionless-pkg");
      await mkdir(packageDirectory, { recursive: true });
      await writeBuildFile({ directory: packageDirectory }, "package.json", JSON.stringify({ name: "extensionless-pkg", version: "1.0.0", type: "module", main: "./entry" }));
      await writeBuildFile({ directory: packageDirectory }, "real-entry", "this is invalid authored target bytes\n");
      await symlink(path.join(packageDirectory, "real-entry"), path.join(packageDirectory, "entry"));
      await assertHostileSource(project, "import 'extensionless-pkg';\n", /static source path leaf is not a regular file|static source path is not regular/u);
    } finally {
      clearMarker();
      await removeBuildTestPaths(project.directory, modules);
    }
  });

  it("rejects a type-only package through a symlinked node_modules path before TypeScript reads it", async () => {
    const project = await createBuildTestProject();
    const modules = await mkdtemp(path.join(os.tmpdir(), "simfile-b54-types-"));
    const evidence = "BarePackageTypeReadBeforePathGate";
    try {
      const packageDirectory = path.join(modules, "type-escape");
      await mkdir(packageDirectory, { recursive: true });
      await writeBuildFile({ directory: packageDirectory }, "package.json", JSON.stringify({
        name: "type-escape", version: "1.0.0", types: "./index.d.ts", evidence
      }));
      await writeBuildFile({ directory: packageDirectory }, "index.d.ts", `export type Value = ${evidence};\n`);
      await symlink(modules, path.join(project.directory, "node_modules"));
      await writeBuildFile(project, "systems/provider.ts", `/// <reference types="type-escape" />\nexport const value = 1;\n`);
      await assert.rejects(prepareBuild(project, "./systems/provider.ts"), (error: Error) => {
        assert.match(error.message, /static source path is not regular/u);
        assert.doesNotMatch(error.message, new RegExp(evidence, "u"));
        return true;
      });
      assertMarkerAbsent();
    } finally {
      clearMarker();
      await removeBuildTestPaths(project.directory, modules);
    }
  });

  it("preflights triple-slash path references before TypeScript diagnostics", async () => {
    const project = await createBuildTestProject();
    try {
      await writeBuildFile(project, "systems/real-types.d.ts", "export type Value = MissingTypeReadBeforePathGate;\n");
      await symlink(path.join(project.directory, "systems", "real-types.d.ts"), path.join(project.directory, "systems", "linked-types.d.ts"));
      await writeBuildFile(project, "systems/provider.ts", withMarker("/// <reference path=\"./linked-types.d.ts\" />\nexport const value = 1;\n"));
      await assert.rejects(prepareBuild(project, "./systems/provider.ts"), (error: Error) => {
        assert.match(error.message, /static source path leaf is not a regular file/u);
        assert.doesNotMatch(error.message, /MissingTypeReadBeforePathGate/u);
        return true;
      });
      assertMarkerAbsent();
      await unlink(path.join(project.directory, "systems", "linked-types.d.ts"));

      await addPackage(path.join(project.directory, "node_modules", "type-pkg"), "type-pkg", "1.0.0", "export const runtime = 1;\n");
      await writeBuildFile(project, "node_modules/type-pkg/index.d.ts", "export type Value = number;\n");
      await writeBuildFile(project, "systems/provider.ts", withMarker("/// <reference path=\"../node_modules/type-pkg/index.d.ts\" />\nexport const value = 1;\n"));
      await assert.rejects(prepareBuild(project, "./systems/provider.ts"), /relative import escape/u);
      assertMarkerAbsent();

      await writeBuildFile(project, "systems/nested-types.d.ts", "declare type LocalValue = number;\n");
      await writeBuildFile(project, "systems/linked-types.d.ts", "/// <reference path=\"nested-types.d.ts\" />\n");
      await writeBuildFile(project, "systems/provider.ts", "/// <reference path=\"linked-types.d.ts\" />\nexport const value: LocalValue = 1;\n");
      const prepared = await prepareBuild(project, "./systems/provider.ts");
      assert.equal(prepared.typecheckMode, "typescript");
      assertMarkerAbsent();
    } finally {
      clearMarker();
      await removeBuildTestPaths(project.directory);
    }
  });

  it("records guarded compiler-injected Node and Undici checked inputs", async () => {
    const project = await createBuildTestProject();
    try {
      await writeBuildFile(project, "systems/provider.ts", "export const value: number = 1;\n");
      const prepared = await prepareBuild(project, "./systems/provider.ts");
      assert.equal(prepared.inputs.some((input) => input.kind === "package" && input.package_name === "@types/node" && input.modes.includes("type-only")), true);
      assert.equal(prepared.inputs.some((input) => input.kind === "package" && input.package_name === "undici-types" && input.modes.includes("type-only")), true);
    } finally { await removeBuildTestPaths(project.directory); }
  });

  it("keeps a default value plus named type import in immutable runtime evidence", async () => {
    const project = await createBuildTestProject();
    try {
      await writeBuildFile(project, "systems/runtime.ts", "export default 7;\nexport type RuntimeValue = number;\n");
      await writeBuildFile(project, "systems/provider.ts", "import value, { type RuntimeValue } from './runtime.ts';\nexport const output: RuntimeValue = value;\n");
      const prepared = await prepareBuild(project, "./systems/provider.ts");
      assert.equal(prepared.inputs.some((input) => input.kind === "project" && input.path === "./systems/runtime.ts" && input.modes.includes("runtime")), true);
    } finally { await removeBuildTestPaths(project.directory); }
  });
});
