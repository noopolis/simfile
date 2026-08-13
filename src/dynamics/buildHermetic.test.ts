import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { artifactText, createBuildTestProject, prepareBuild, removeBuildTestPaths, writeBuildFile } from "./buildTestSupport.test-helper.js";
import { nodeModulesPackageFor } from "./buildPackagePolicy.js";

const header = (prepared: Awaited<ReturnType<typeof prepareBuild>>): string =>
  `/* simfile-dynamics-closure-sha256:${prepared.closureSha256} */\n`;

const assertChanged = (before: Awaited<ReturnType<typeof prepareBuild>>, after: Awaited<ReturnType<typeof prepareBuild>>): void => {
  assert.notEqual(after.closureSha256, before.closureSha256);
  assert.notEqual(header(after), header(before));
  assert.notDeepEqual(after.artifactBytes, before.artifactBytes);
};

const addPackage = async (directory: string, name: string, version: string, source: string): Promise<void> => {
  await writeBuildFile({ directory }, `package.json`, JSON.stringify({ name, version, type: "module", main: "./index.mjs" }));
  await writeBuildFile({ directory }, "index.mjs", source);
};

const addTypeScriptPackage = async (directory: string, name: string, source: string): Promise<void> => {
  await writeBuildFile({ directory }, "package.json", JSON.stringify({ name, version: "1.0.0", type: "module", main: "./index.ts" }));
  await writeBuildFile({ directory }, "index.ts", source);
};

const addTypeScriptDeclarationPackage = async (directory: string, name: string, source: string): Promise<void> => {
  await writeBuildFile({ directory }, "package.json", JSON.stringify({ name, version: "1.0.0", type: "module", main: "./index.d.ts" }));
  await writeBuildFile({ directory }, "index.d.ts", source);
};

const addJavaScriptPackage = async (directory: string, name: string, source: string, type: "module" | "commonjs"): Promise<void> => {
  await writeBuildFile({ directory }, "package.json", JSON.stringify({ name, version: "1.0.0", type, main: "./index.js" }));
  await writeBuildFile({ directory }, "index.js", source);
};

describe("hermetic dynamics build preparation", () => {
  it("keeps nested authored projects portable across absolute roots", async () => {
    const firstRoot = await mkdtemp(path.join(os.tmpdir(), "simfile-ancestor-"));
    const secondRoot = await mkdtemp(path.join(os.tmpdir(), "simfile-ancestor-"));
    try {
      for (const root of [firstRoot, secondRoot]) await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "ancestor", type: "commonjs" }));
      const first = await createBuildTestProject(path.join(firstRoot, "nested"));
      const second = await createBuildTestProject(path.join(secondRoot, "nested"));
      for (const project of [first, second]) {
        await writeBuildFile(project, "systems/helper.mjs", "export const helper = 2;\n");
        await writeBuildFile(project, "systems/provider.mjs", "import { helper } from './helper.mjs'; export const value = helper;\n");
      }
      const one = await prepareBuild(first);
      const two = await prepareBuild(second);
      assert.deepEqual(one.artifactBytes, two.artifactBytes);
      assert.equal(one.closureSha256, two.closureSha256);
      for (const prepared of [one, two]) {
        assert.ok(prepared.inputs.every((input) => input.kind !== "project" || input.path.startsWith("./systems/")));
        assert.doesNotMatch(JSON.stringify(prepared), /simfile-ancestor-/u);
      }
    } finally {
      await removeBuildTestPaths(firstRoot, secondRoot);
    }
  });

  it("normalizes enclosing and project-local packages before project containment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "simfile-packages-"));
    try {
      const project = await createBuildTestProject(path.join(root, "projects"));
      await addPackage(path.join(root, "node_modules", "enclosing-pkg"), "enclosing-pkg", "1.0.0", "export const enclosing = 2;\n");
      await addPackage(path.join(project.directory, "node_modules", "local-pkg"), "local-pkg", "1.0.0", "export const local = 3;\n");
      await writeBuildFile(project, "systems/provider.mjs", "import { enclosing } from 'enclosing-pkg'; import { local } from 'local-pkg'; export const value = enclosing + local;\n");
      const prepared = await prepareBuild(project);
      for (const packageName of ["enclosing-pkg", "local-pkg"]) {
        assert.ok(prepared.inputs.some((input) => input.kind === "package" && input.package_name === packageName && input.package_path === "./index.mjs"));
      }
      assert.equal(prepared.inputs.some((input) => input.kind === "project" && input.path.includes("node_modules")), false);
    } finally {
      await removeBuildTestPaths(root);
    }
  });

  it("binds isolated package source and manifest mutations into closure headers and artifacts", async () => {
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "simfile-package-source-"));
    const manifestRoot = await mkdtemp(path.join(os.tmpdir(), "simfile-package-manifest-"));
    try {
      for (const [root, mutation] of [[sourceRoot, "source"], [manifestRoot, "manifest"]] as const) {
        const project = await createBuildTestProject(path.join(root, "projects"));
        const packageDirectory = path.join(project.directory, "node_modules", "identity-pkg");
        await addPackage(packageDirectory, "identity-pkg", "1.0.0", "export const value = 1;\n");
        await writeBuildFile(project, "systems/provider.mjs", "import { value } from 'identity-pkg'; export { value };\n");
        const before = await prepareBuild(project);
        if (mutation === "source") await writeBuildFile({ directory: packageDirectory }, "index.mjs", "export const value = 2;\n");
        else await writeBuildFile({ directory: packageDirectory }, "package.json", JSON.stringify({ name: "identity-pkg", version: "1.0.1", type: "module", main: "./index.mjs" }));
        assertChanged(before, await prepareBuild(project));
      }
    } finally {
      await removeBuildTestPaths(sourceRoot, manifestRoot);
    }
  });

  it("ignores project package sideEffects for both identity and bytes", async () => {
    const project = await createBuildTestProject();
    try {
      await writeBuildFile(project, "package.json", JSON.stringify({ name: "authored-project", sideEffects: true }));
      await writeBuildFile(project, "systems/effect.mjs", "globalThis.__simfile_effect = true;\n");
      await writeBuildFile(project, "systems/provider.mjs", "import './effect.mjs'; export const value = 1;\n");
      const before = await prepareBuild(project);
      await writeBuildFile(project, "package.json", JSON.stringify({ name: "authored-project", sideEffects: false }));
      const after = await prepareBuild(project);
      assert.equal(after.closureSha256, before.closureSha256);
      assert.deepEqual(after.artifactBytes, before.artifactBytes);
    } finally {
      await removeBuildTestPaths(project.directory);
    }
  });

  it("uses the same host-owned NodeNext acceptance nested and standalone", async () => {
    const ancestor = await mkdtemp(path.join(os.tmpdir(), "simfile-nodenext-"));
    const standalone = await createBuildTestProject();
    try {
      await writeFile(path.join(ancestor, "package.json"), JSON.stringify({ name: "ancestor", type: "commonjs" }));
      const nested = await createBuildTestProject(path.join(ancestor, "nested"));
      const source = "export const url = import.meta.url;\n";
      for (const project of [nested, standalone]) await writeBuildFile(project, "systems/provider.ts", source);
      const nestedBuild = await prepareBuild(nested, "./systems/provider.ts");
      const standaloneBuild = await prepareBuild(standalone, "./systems/provider.ts");
      assert.deepEqual(nestedBuild.artifactBytes, standaloneBuild.artifactBytes);
      assert.equal(nestedBuild.closureSha256, standaloneBuild.closureSha256);
    } finally {
      await removeBuildTestPaths(ancestor, standalone.directory);
    }
  });

  it("ignores every authored project package type when checking NodeNext", async () => {
    const commonjs = await createBuildTestProject();
    const module = await createBuildTestProject();
    try {
      const source = "export const url = import.meta.url;\n";
      for (const project of [commonjs, module]) await writeBuildFile(project, "systems/provider.ts", source);
      await writeBuildFile(commonjs, "systems/package.json", JSON.stringify({ type: "commonjs" }));
      await writeBuildFile(module, "systems/package.json", JSON.stringify({ type: "module" }));
      const first = await prepareBuild(commonjs, "./systems/provider.ts");
      const second = await prepareBuild(module, "./systems/provider.ts");
      assert.equal(first.closureSha256, second.closureSha256);
      assert.deepEqual(first.artifactBytes, second.artifactBytes);
    } finally {
      await removeBuildTestPaths(commonjs.directory, module.directory);
    }
  });

  it("does not permit @ts-nocheck to hide a semantic error", async () => {
    const project = await createBuildTestProject();
    try {
      await writeBuildFile(project, "systems/provider.ts", "// @ts-nocheck\nexport const value: string = 1;\n");
      await assert.rejects(prepareBuild(project, "./systems/provider.ts"), /rejects diagnostic suppression/u);
    } finally {
      await removeBuildTestPaths(project.directory);
    }
  });

  it("rejects effective suppressions but accepts inert directive-looking text", async () => {
    const project = await createBuildTestProject();
    try {
      await writeBuildFile(project, "systems/provider.ts", [
        "// Documentation mentions @ts-ignore but this is not a directive.",
        "export const plain = '@ts-nocheck';",
        "export const template = `@ts-expect-error`;"
      ].join("\n"));
      await prepareBuild(project, "./systems/provider.ts");
      for (const directive of ["@ts-ignore", "@ts-expect-error"]) {
        await writeBuildFile(project, "systems/provider.ts", `// ${directive}\nexport const bad: string = 1;\n`);
        await assert.rejects(prepareBuild(project, "./systems/provider.ts"), /rejects diagnostic suppression/u);
      }
      await addTypeScriptPackage(path.join(project.directory, "node_modules", "unchecked-pkg"), "unchecked-pkg", "// @ts-nocheck\nexport const bad: string = 1;\n");
      await writeBuildFile(project, "systems/provider.ts", "import { bad } from 'unchecked-pkg'; export { bad };\n");
      await assert.rejects(prepareBuild(project, "./systems/provider.ts"), /rejects diagnostic suppression/u);
    } finally {
      await removeBuildTestPaths(project.directory);
    }
  });

  it("checks reachable TypeScript from .ts and .mjs entries and leaves inert comments alone", async () => {
    const project = await createBuildTestProject();
    try {
      const bad = "export const value: string = 1;\n";
      for (const entry of ["./systems/provider.ts", "./systems/provider.mjs"]) {
        await writeBuildFile(project, "systems/provider.ts", "import { value } from './helper.ts'; export { value };\n");
        await writeBuildFile(project, "systems/provider.mjs", "import { value } from './helper.ts'; export { value };\n");
        await writeBuildFile(project, "systems/provider.cjs", "const { value } = require('./helper.ts'); module.exports = { value };\n");
        await writeBuildFile(project, "systems/helper.ts", bad);
        await assert.rejects(prepareBuild(project, entry), /TypeScript check failed/u);
        for (const directive of ["@ts-nocheck", "@ts-ignore", "@ts-expect-error"]) {
          await writeBuildFile(project, "systems/helper.ts", `// ${directive}\n${bad}`);
          await assert.rejects(prepareBuild(project, entry), /rejects diagnostic suppression/u);
        }
      }
      await writeBuildFile(project, "systems/helper.ts", ["const text = '@ts-nocheck';", "const template = `@ts-ignore`;", "// prose mentions @ts-expect-error", "/* @ts-nocheck */", "export const value = 1; // @ts-ignore"].join("\n"));
      assert.equal((await prepareBuild(project, "./systems/provider.mjs")).typecheckMode, "typescript");
      const packageDirectory = path.join(project.directory, "node_modules", "checked-pkg");
      const declarationPackageDirectory = path.join(project.directory, "node_modules", "checked-declarations");
      await writeBuildFile(project, "systems/provider.mjs", "import { value } from 'checked-pkg'; export { value };\n");
      for (const directive of ["@ts-nocheck", "@ts-ignore", "@ts-expect-error"]) {
        await addTypeScriptPackage(packageDirectory, "checked-pkg", `// ${directive}\nexport const value: string = 1;\n`);
        await assert.rejects(prepareBuild(project), /rejects diagnostic suppression/u);
      }
      await writeBuildFile(project, "systems/provider.mjs", "import { value } from 'checked-declarations'; export const value2 = value;\n");
      await addTypeScriptDeclarationPackage(declarationPackageDirectory, "checked-declarations", `// @ts-ignore\nexport const value: string = 1;\n`);
      await assert.rejects(prepareBuild(project), /rejects diagnostic suppression/u);
      for (const extension of ["mts", "cts", "tsx"]) {
        await writeBuildFile(project, `systems/helper.${extension}`, "export const value = 1;\n");
        await writeBuildFile(project, "systems/provider.mjs", `import { value } from './helper.${extension}'; export { value };\n`);
        await assert.rejects(prepareBuild(project), /unsupported reachable TypeScript/u);
      }
      await removeBuildTestPaths(
        path.join(project.directory, "systems", "helper.mts"),
        path.join(project.directory, "systems", "helper.cts"),
        path.join(project.directory, "systems", "helper.tsx")
      );
      for (const extension of [".d.mts", ".d.cts"] as const) {
        await writeBuildFile(project, `systems/helper${extension}`, "export type Value = string;\n");
        await writeBuildFile(project, "systems/provider.ts", `import type { Value } from './helper${extension}'; export const local: Value = \"\";\n`);
        const prepared = await prepareBuild(project, "./systems/provider.ts");
        assert.ok(prepared.inputs.some((input) => input.kind === "project" && input.path === `./systems/helper${extension}` && input.modes[0] === "type-only"));
      }
    } finally { await removeBuildTestPaths(project.directory); }
  });

  it("prefers package-local node_modules .js inputs before ambiguous authored .js", async () => {
    const project = await createBuildTestProject();
    try {
      const modulePackage = path.join(project.directory, "node_modules", "module-pkg");
      const commonjsPackage = path.join(project.directory, "node_modules", "commonjs-pkg");
      await addJavaScriptPackage(modulePackage, "module-pkg", "export const value = 1;\n", "module");
      await addJavaScriptPackage(commonjsPackage, "commonjs-pkg", "exports.value = 1;\n", "commonjs");
      await writeBuildFile(project, "systems/provider.mjs", "import { value as moduleValue } from 'module-pkg'; import * as commonjsValue from 'commonjs-pkg'; export const value = moduleValue + commonjsValue.value;\n");
      const prepared = await prepareBuild(project);
      assert.ok(prepared.inputs.some((input) => input.kind === "package" && input.package_name === "module-pkg" && input.package_path === "./index.js"));
      assert.ok(prepared.inputs.some((input) => input.kind === "package" && input.package_name === "commonjs-pkg" && input.package_path === "./index.js"));
      await writeBuildFile(project, "systems/helper.js", "export const value = 1;\n");
      await writeBuildFile(project, "systems/provider.mjs", "import { value as moduleValue } from 'module-pkg'; import * as commonjsValue from 'commonjs-pkg'; import { value as helper } from './helper.js'; export const value = moduleValue + commonjsValue.value + helper;\n");
      await assert.rejects(prepareBuild(project), /ambiguous authored \.js/iu);
    } finally {
      await removeBuildTestPaths(project.directory);
    }
  });

  it("fails closed for invalid package owners and preserves scoped portable descriptors", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "simfile-package-owner-"));
    try {
      const cases: readonly [string, string][] = [
        ["missing", ""],
        ["malformed", "{"],
        ["array", "[]"],
        ["absent", "{}"],
        ["non-string", JSON.stringify({ name: 1, version: 1 })],
        ["empty", JSON.stringify({ name: "", version: "" })],
        ["invalid", JSON.stringify({ name: "bad name", version: "version" })]
      ];
      for (const [label, manifest] of cases) {
        const project = await createBuildTestProject(path.join(root, label));
        const packageDirectory = path.join(project.directory, "node_modules", "invalid-pkg");
        await writeBuildFile({ directory: packageDirectory }, "index.mjs", "export const value = 1;\n");
        if (manifest) await writeBuildFile({ directory: packageDirectory }, "package.json", manifest);
        await assert.rejects(nodeModulesPackageFor(path.join(packageDirectory, "index.mjs")));
      }
      const project = await createBuildTestProject(path.join(root, "scoped"));
      await addPackage(path.join(root, "node_modules", "@outer", "enclosing"), "@outer/enclosing", "1.2.3", "export const outer = 1;\n");
      await addPackage(path.join(project.directory, "node_modules", "@local", "owned"), "@local/owned", "2.3.4", "export const local = 2;\n");
      await writeBuildFile(project, "systems/provider.mjs", "import { outer } from '@outer/enclosing'; import { local } from '@local/owned'; export const value = outer + local;\n");
      const prepared = await prepareBuild(project);
      assert.ok(prepared.inputs.some((input) => input.kind === "package" && input.package_name === "@outer/enclosing" && input.package_version === "1.2.3" && input.package_path === "./index.mjs"));
      assert.ok(prepared.inputs.some((input) => input.kind === "package" && input.package_name === "@local/owned" && input.package_version === "2.3.4" && input.package_path === "./index.mjs"));
    } finally {
      await removeBuildTestPaths(root);
    }
  });

  it("requires node_modules path ownership and real SemVer", async () => {
    const project = await createBuildTestProject();
    try {
      for (const [relative, name] of [["node_modules/plain", "other"], ["node_modules/@scope/pkg", "@scope/other"], ["node_modules/outer/node_modules/inner", "outer"]] as const) {
        const directory = path.join(project.directory, relative);
        await addPackage(directory, name, "1.0.0", "export const value = 1;\n");
        await writeBuildFile(project, "systems/provider.mjs", `import { value } from '${relative.includes("@scope") ? "@scope/pkg" : relative.includes("inner") ? "outer" : "plain"}'; export { value };\n`);
        if (relative.includes("inner")) {
          await addPackage(path.join(project.directory, "node_modules", "outer"), "outer", "1.0.0", "import { value } from 'inner'; export { value };\n");
        }
        await assert.rejects(prepareBuild(project), /does not own its node_modules path/u);
      }
      const directory = path.join(project.directory, "node_modules", "semver-pkg");
      await addPackage(directory, "semver-pkg", "1.0.0-01", "export const value = 1;\n");
      await writeBuildFile(project, "systems/provider.mjs", "import { value } from 'semver-pkg'; export { value };\n");
      await assert.rejects(prepareBuild(project), /invalid package identity/u);
      await addPackage(directory, "semver-pkg", "1.2.3-alpha.1+build.05", "export const value = 1;\n");
      await prepareBuild(project);
    } finally { await removeBuildTestPaths(project.directory); }
  });

  it("fails closed for project .js while explicit module extensions ignore project type", async () => {
    const first = await createBuildTestProject();
    const second = await createBuildTestProject();
    try {
      for (const [project, type] of [[first, "commonjs"], [second, "module"]] as const) {
        await writeBuildFile(project, "package.json", JSON.stringify({ name: "authored-project", type }));
        await writeBuildFile(project, "systems/helper.js", "export const value = 1;\n");
        await writeBuildFile(project, "systems/provider.mjs", "import { value } from './helper.js'; export { value };\n");
        await assert.rejects(prepareBuild(project), /ambiguous authored .js/u);
        await writeBuildFile(project, "systems/helper.mjs", "export const value = 1;\n");
        await writeBuildFile(project, "systems/provider.mjs", "import { value } from './helper.mjs'; export { value };\n");
      }
      assert.deepEqual((await prepareBuild(first)).artifactBytes, (await prepareBuild(second)).artifactBytes);
      for (const project of [first, second]) {
        await writeBuildFile(project, "systems/helper.cjs", "exports.value = 1;\n");
        await writeBuildFile(project, "systems/provider.mjs", "import helper from './helper.cjs'; export const value = helper.value;\n");
      }
      assert.deepEqual((await prepareBuild(first)).artifactBytes, (await prepareBuild(second)).artifactBytes);
    } finally { await removeBuildTestPaths(first.directory, second.directory); }
  });

  it("selects the nearest nested node_modules owner", async () => {
    const project = await createBuildTestProject();
    try {
      const outer = path.join(project.directory, "node_modules", "outer-pkg");
      const inner = path.join(outer, "node_modules", "inner-pkg");
      await addPackage(outer, "outer-pkg", "1.0.0", "import { inner } from 'inner-pkg'; export const outer = inner;\n");
      await addPackage(inner, "inner-pkg", "2.0.0", "export const inner = 2;\n");
      await writeBuildFile(project, "systems/provider.mjs", "import { outer } from 'outer-pkg'; export { outer };\n");
      const prepared = await prepareBuild(project);
      assert.ok(prepared.inputs.some((input) => input.kind === "package" && input.package_name === "inner-pkg" && input.package_version === "2.0.0" && input.package_path === "./index.mjs"));
    } finally {
      await removeBuildTestPaths(project.directory);
    }
  });

  it("never executes authored top-level or factory code while preparing", async () => {
    const project = await createBuildTestProject();
    const marker = "__simfile_build_marker__";
    try {
      delete (globalThis as Record<string, unknown>)[marker];
      await writeBuildFile(project, "systems/provider.mjs", `globalThis[${JSON.stringify(marker)}] = 'top'; export const create = () => globalThis[${JSON.stringify(marker)}] = 'factory';`);
      const prepared = await prepareBuild(project);
      assert.equal((globalThis as Record<string, unknown>)[marker], undefined);
      assert.match(artifactText(prepared), /__simfile_build_marker__/u);
    } finally {
      delete (globalThis as Record<string, unknown>)[marker];
      await removeBuildTestPaths(project.directory);
    }
  });
});
