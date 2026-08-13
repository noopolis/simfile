import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { build } from "esbuild";

import { createDynamicsClosureIdentity } from "./buildIdentity.js";
import {
  assertStaticEmittedEsm,
  assertStaticSource,
  auditStaticMetafileImports,
  classifyStaticModuleSpecifier,
  DYNAMICS_STATIC_CLOSURE_POLICY,
  staticPreserveSymlinks,
  type StaticClosurePolicy,
  validateStaticSourcePath
} from "./buildStaticPolicy.js";
import { preflightStaticGraph } from "./buildStaticResolverPolicy.js";
import { staticSourceSpecifiers } from "./buildStaticResolverPolicy.js";
import { assertExactRuntimeInputs } from "./buildStaticGraphPolicy.js";

const clonePolicy = (): StaticClosurePolicy => JSON.parse(JSON.stringify(DYNAMICS_STATIC_CLOSURE_POLICY)) as StaticClosurePolicy;
const changed = (policy: unknown): StaticClosurePolicy => policy as StaticClosurePolicy;
const identity = (preparationPolicy: unknown): string => createDynamicsClosureIdentity({
  buildContract: {}, entry: "./provider.mjs", esbuildVersion: "1", inputs: [], preparationPolicy, typecheckMode: "none", typescriptVersion: "1", usedNodeBuiltins: []
}).sha256;

const buildClosedCommonJsOutput = async (): Promise<string> => {
  const result = await build({
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    stdin: {
      contents: "import c from './cdep';\nvar x = await import('./esmdep');\nconsole.log(c.value, x.value);\n",
      sourcefile: "index.js",
      resolveDir: process.cwd(),
      loader: "js",
    },
    plugins: [{
      name: "b54-closed-cjs-fixture",
      setup(api) {
        api.onResolve({ filter: /^\.\/cdep$/ }, () => ({ namespace: "virtual:cdep", path: "cdep" }));
        api.onResolve({ filter: /^\.\/esmdep$/ }, () => ({ namespace: "virtual:esmdep", path: "esmdep" }));
        api.onLoad({ filter: /^cdep$/, namespace: "virtual:cdep" }, () => ({ contents: "module.exports = { value: 1, default: 2 };\n", loader: "js" }));
        api.onLoad({ filter: /^esmdep$/, namespace: "virtual:esmdep" }, () => ({ contents: "export const value = 3;\n", loader: "js" }));
      },
    }],
  });
  if (result.outputFiles === undefined || result.outputFiles.length === 0) {
    throw new Error("static policy fixture does not include emitted output");
  }
  return result.outputFiles[0].text;
};

const replacePinned = (output: string, expected: string, replacement: string): string => {
  assert.equal(output.includes(expected), true, `pinned esbuild output must contain ${expected}`);
  const index = output.lastIndexOf(expected);
  return `${output.slice(0, index)}${replacement}${output.slice(index + expected.length)}`;
};

describe("static source closure policy", () => {
  it("deeply freezes and every policy group drives validation", async () => {
    const walk = (value: unknown): void => {
      if (value && typeof value === "object") {
        assert.equal(Object.isFrozen(value), true);
        for (const child of Object.values(value as Record<string, unknown>)) walk(child);
      }
    };
    walk(DYNAMICS_STATIC_CLOSURE_POLICY);
    const root = await mkdtemp(path.join(os.tmpdir(), "simfile-static-policy-"));
    try {
      await writeFile(path.join(root, "source.mjs"), "export const value = 1;\n");
      const buildPolicy = changed({ ...clonePolicy(), build: { preserveSymlinks: false } });
      const pathPolicy = changed({ ...clonePolicy(), path: { ...clonePolicy().path, leaf: "other" } });
      const sourcePolicy = changed({ ...clonePolicy(), source: { ...clonePolicy().source, lookupForms: ["dynamic-import"] } });
      const specifierPolicy = changed({ ...clonePolicy(), specifier: { ...clonePolicy().specifier, approvedNodeBuiltins: [] } });
      const metafilePolicy = changed({ ...clonePolicy(), metafile: { ...clonePolicy().metafile, externalFlag: false } });
      const emittedPolicy = changed({ ...clonePolicy(), emitted: { ...clonePolicy().emitted, commonJsInitializerIdentifiers: [] } });
      for (const policy of [buildPolicy, pathPolicy, sourcePolicy, specifierPolicy, metafilePolicy, emittedPolicy]) {
        assert.notEqual(identity(DYNAMICS_STATIC_CLOSURE_POLICY), identity(policy));
      }
      assert.throws(() => staticPreserveSymlinks(buildPolicy), /symlink preservation/u);
      await assert.rejects(validateStaticSourcePath(path.join(root, "source.mjs"), root, pathPolicy), /leaf path policy/u);
      assert.throws(() => assertStaticSource("source.mjs", "require('node:crypto');", sourcePolicy), /require/u);
      assert.throws(() => classifyStaticModuleSpecifier("node:crypto", specifierPolicy), /unapproved/u);
      assert.deepEqual(auditStaticMetafileImports([{ external: false, path: "node:crypto" }], metafilePolicy), ["node:crypto"]);
      assert.throws(() => assertStaticEmittedEsm("out.mjs", "const x = __commonJS(() => {});", emittedPolicy), /unrecognized/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("requires a regular contained path with no symlinked component and closed modes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "simfile-static-path-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "simfile-static-outside-"));
    try {
      await mkdir(path.join(root, "nested"));
      await writeFile(path.join(root, "nested", "source.mjs"), "export {};\n");
      await writeFile(path.join(outside, "outside.mjs"), "export {};\n");
      assert.equal(await validateStaticSourcePath(path.join(root, "nested", "source.mjs"), root), path.join(root, "nested", "source.mjs"));
      await assert.rejects(validateStaticSourcePath(path.join(outside, "outside.mjs"), root));
      await assert.rejects(validateStaticSourcePath(path.join(root, "missing.mjs"), root));
      await assert.rejects(validateStaticSourcePath(path.join(root, "nested"), root));
      await symlink(outside, path.join(root, "link-boundary"));
      await assert.rejects(validateStaticSourcePath(path.join(root, "nested", "source.mjs"), path.join(root, "link-boundary")));
      await symlink(path.join(root, "nested"), path.join(root, "linked-nested"));
      await assert.rejects(validateStaticSourcePath(path.join(root, "linked-nested", "source.mjs"), root));
      await symlink(path.join(root, "nested", "source.mjs"), path.join(root, "leaf.mjs"));
      await assert.rejects(validateStaticSourcePath(path.join(root, "leaf.mjs"), root));
      assert.equal((await lstat(path.join(root, "leaf.mjs"))).isSymbolicLink(), true);
      for (const pathPolicy of [
        changed({ ...clonePolicy(), path: { ...clonePolicy().path, boundary: "other" } }),
        changed({ ...clonePolicy(), path: { ...clonePolicy().path, traversedDirectories: "other" } }),
        changed({ ...clonePolicy(), path: { ...clonePolicy().path, lexicalContainment: "other" } })
      ]) await assert.rejects(validateStaticSourcePath(path.join(root, "nested", "source.mjs"), root, pathPolicy));
    } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });

  it("accepts static source forms and rejects require capability and specifier escapes", () => {
    assert.doesNotThrow(() => assertStaticSource("source.ts", "import x from './x.mjs'; export { x } from './y.mjs'; import('./z.mjs'); require('pkg');"));
    assert.doesNotThrow(() => assertStaticSource("source.mjs", "import('./local.mjs');"));
    assert.throws(() => assertStaticSource("source.mjs", "import(\'./local.mjs\', { with: { type: \'json\' } });"), /static source/u);
    assert.doesNotThrow(() => assertStaticSource("source.mjs", "const target = { load(x: unknown) { return x; } }; target['load'](1); target.load(1);"));
    assert.doesNotThrow(() => assertStaticSource("source.mjs", "const target = { load(x: unknown) { return x; } }; target[\"lo\" + \"ad\"](1);"));
    for (const source of [
      "import(x);", "require(x);", "(require)(x);", "((require))(x);", "(0, require)(x);", "require.call(null, x);", "const r = require; r(x);",
      "globalThis['require'](x);", "globalThis.require(x);", "globalThis['require']?.(x);", "globalThis.require?.(x);", "module['require']?.(x);",
      "module?.require(x);", "require?.(x);", "require['call'](x);", "globalThis['createRequire']('file:///.');",
      "const r = createRequire; r(x);", "import('pkg');", "import('node:fs');", "import('/x.mjs');",
      "import('https://example.test/x.mjs');", "import('./' + 'local.mjs');"
    ]) assert.throws(() => assertStaticSource("source.mjs", source), /static source/u);
    for (const source of ["import 'https://example.test/x.mjs';", "import '/x.mjs';", "import 'C:\\\\x.mjs';", "import 'crypto';", "import '_http_agent';", "import 'node:fs';"]) {
      assert.throws(() => assertStaticSource("source.mjs", source), /static source/u);
    }
    assert.equal(classifyStaticModuleSpecifier("./x.mjs"), "relative");
    assert.equal(classifyStaticModuleSpecifier("pkg"), "package");
    assert.equal(classifyStaticModuleSpecifier("node:crypto"), "node-builtin");
    const changedDrive = changed({ ...clonePolicy(), specifier: { ...clonePolicy().specifier, windowsDriveAbsolutePattern: "^Z:" } });
    const changedUrl = changed({ ...clonePolicy(), specifier: { ...clonePolicy().specifier, urlSchemePattern: "^z:" } });
    assert.equal(classifyStaticModuleSpecifier("C:\\x.mjs", changedDrive), "package");
    assert.equal(classifyStaticModuleSpecifier("https://example.test/x.mjs", changedUrl), "package");
  });

  it("handles import-equals and fails closed on extension-family changes", () => {
    assert.doesNotThrow(() => assertStaticSource("source.ts", "import local = require('./local'); export = local;"));
    for (const source of ["import fs = require('fs');", "import fs = require('node:fs');", "import bad = require('https://example.test/x');"]) {
      assert.throws(() => assertStaticSource("source.ts", source), /static source/u);
    }
    const noTs = changed({ ...clonePolicy(), source: { ...clonePolicy().source, typeScriptExtensions: [] } });
    const noMjs = changed({ ...clonePolicy(), source: { ...clonePolicy().source, javaScriptExtensions: [".js", ".cjs"] } });
    assert.throws(() => assertStaticSource("source.ts", "export {};", noTs), /unsupported extension/u);
    assert.throws(() => assertStaticSource("source.mjs", "export {};", noMjs), /unsupported extension/u);
    assert.throws(() => assertStaticSource("source.unknown", "export {};"), /unsupported extension/u);
  });

  it("rejects unsupported graph filenames before attempting a source read", async () => {
    let reads = 0;
    await assert.rejects(preflightStaticGraph(["/fixture/extensionless"], DYNAMICS_STATIC_CLOSURE_POLICY, {
      edge: () => undefined,
      inspect: () => undefined,
      read: async () => { reads += 1; return "export const value = 1;"; },
      resolve: () => undefined,
      validate: async (fileName) => ({ fileName })
    }), /unsupported extension/u);
    assert.equal(reads, 0);
  });

  it("classifies erased edges as type-only while retaining mixed value reachability", () => {
    const edges = staticSourceSpecifiers("fixture.ts", [
      "/// <reference types=\"node\" />",
      "/// <reference path=\"./path.d.ts\" />",
      "import type { Type } from './types.ts';",
      "import Default, { type Type } from './default-mixed.ts';",
      "export type { Type } from './types.ts';",
      "import { type Type, value } from './mixed.ts';",
      "type FromImport = import('./imported.ts').Value;"
    ].join("\n"), DYNAMICS_STATIC_CLOSURE_POLICY);
    assert.deepEqual(edges.map((edge) => [edge.specifier, edge.mode]), [
      ["./types.ts", "type-only"], ["./default-mixed.ts", "runtime"], ["./types.ts", "type-only"], ["./mixed.ts", "runtime"],
      ["./imported.ts", "type-only"], ["node", "type-only"], ["./path.d.ts", "type-only"]
    ]);
  });

  it("reports both missing and extra immutable runtime preflight evidence", () => {
    assert.throws(() => assertExactRuntimeInputs(new Set(["/expected.mjs"]), ["/observed.mjs"]), /missing: \/expected\.mjs; extra: \/observed\.mjs/u);
  });

  it("rejects unsafe path references before resolving or reading their targets", async () => {
    for (const reference of ["/absolute.d.ts", "C:\\\\absolute.d.ts", "https://example.test/types.d.ts"]) {
      let reads = 0;
      let resolves = 0;
      await assert.rejects(preflightStaticGraph(["/fixture/source.ts"], DYNAMICS_STATIC_CLOSURE_POLICY, {
        edge: () => undefined,
        inspect: () => undefined,
        read: async () => { reads += 1; return `/// <reference path=\"${reference}\" />\nexport {};`; },
        resolve: () => { resolves += 1; return "/fixture/target.d.ts"; },
        validate: async (fileName) => ({ fileName })
      }), /unsafe path reference/u);
      assert.equal(reads, 1);
      assert.equal(resolves, 0);
    }
  });

  it("uses only policy-derived approved builtins and UTF-16 metafile ordering", () => {
    const sortingPolicy = changed({ ...clonePolicy(), specifier: { ...clonePolicy().specifier, approvedNodeBuiltins: ["node:z", "node:crypto", "node:a"] } });
    const used = auditStaticMetafileImports([
      { external: true, path: "node:crypto" }, { external: false, path: "./bundled.mjs" }, { external: true, path: "node:z" }, { external: true, path: "node:a" }, { external: true, path: "node:crypto" }
    ], sortingPolicy);
    assert.deepEqual(used, ["node:a", "node:crypto", "node:z"]);
    assert.throws(() => auditStaticMetafileImports([{ external: true, path: "pkg" }]));
    assert.throws(() => auditStaticMetafileImports([{ external: true, path: "node:fs" }]));
    const noBuiltins = changed({ ...clonePolicy(), specifier: { ...clonePolicy().specifier, approvedNodeBuiltins: [] } });
    assert.throws(() => auditStaticMetafileImports([{ external: true, path: "node:crypto" }], noBuiltins), /unapproved/u);
    const unsupportedOrdering = changed({ ...clonePolicy(), metafile: { ...clonePolicy().metafile, ordering: "other" } });
    assert.throws(() => auditStaticMetafileImports([], unsupportedOrdering), /ordering/u);
  });

  it("seals emitted ESM while allowing only exact closed CommonJS initialization", async () => {
    const pinned = await buildClosedCommonJsOutput();
    const callOnly = pinned.slice(pinned.indexOf("var require_"));
    assert.throws(() => assertStaticEmittedEsm("out.mjs", callOnly), /emitted ESM/u);
    assert.doesNotThrow(() => assertStaticEmittedEsm("out.mjs", "import { createHash } from 'node:crypto'; export { createHash };"));
    assert.doesNotThrow(() => assertStaticEmittedEsm("out.mjs", pinned));
    const commonJsMutations = [
      ["helper declaration let", "var __commonJS", "let __commonJS"],
      ["helper declaration const", "var __commonJS", "const __commonJS"],
      ["helper declaration extra declarator", "var __commonJS", "var extra = 0, __commonJS"],
      ["helper declaration export", "var __commonJS", "export var __commonJS"],
      ["get-own declaration export", "var __getOwnPropNames", "export var __getOwnPropNames"],
      ["get-own duplicate declaration", "var __commonJS", "var __getOwnPropNames = Object.getOwnPropertyNames;\nvar __commonJS"],
      ["get-own invalid declaration", "var __commonJS", "var __getOwnPropNames = Object.keys;\nvar __commonJS"],
      ["get-own later assignment", "var __commonJS", "__getOwnPropNames = Object.keys;\nvar __commonJS"],
      ["get-own export", "var __commonJS", "export { __getOwnPropNames };\nvar __commonJS"],
      ["get-own extra call", "var __commonJS", "__getOwnPropNames({});\nvar __commonJS"],
      ["outer helper cb default", "(cb, mod) =>", "(cb = {}, mod) =>"],
      ["outer helper mod default", "(cb, mod) =>", "(cb, mod = 0) =>"],
      ["initializer factory exports default", "(exports, module)", "(exports = {}, module)"],
      ["outer helper async modifier", "var __commonJS = (cb, mod) =>", "var __commonJS = async (cb, mod) =>"],
      ["named require generator", "function __require()", "function* __require()"],
      ["try finally block", "  }\n};", "  } finally {\n  }\n};"],
      ["optional get-own-property helper", "Object.getOwnPropertyNames", "Object?.getOwnPropertyNames"],
      ["computed get-own-property helper", "Object.getOwnPropertyNames", "Object[\"getOwnPropertyNames\"]"],
      ["optional resolver array lookup", "cb[__getOwnPropNames(cb)[0]]", "cb?.[__getOwnPropNames(cb)[0]]"],
      ["__copyProps __getOwnPropNames(from) -> __getOwnPropNames?.(from)", "__getOwnPropNames(from)", "__getOwnPropNames?.(from)"],
      ["__esm __getOwnPropNames(fn) -> __getOwnPropNames?.(fn)", "__getOwnPropNames(fn)", "__getOwnPropNames?.(fn)"],
      ["__esm function __init() -> function* __init()", "function __init()", "function* __init()"],
      ["__esm function __init() -> async function __init()", "function __init()", "async function __init()"]
    ] as const;
    for (const [reason, expected, replacement] of commonJsMutations) {
      assert.throws(
        () => assertStaticEmittedEsm("out.mjs", replacePinned(pinned, expected, replacement)),
        /emitted ESM/u,
        reason
      );
    }
    const helper = pinned.slice(pinned.indexOf("var __commonJS"), pinned.indexOf("\n\n//"));
    assert.throws(() => assertStaticEmittedEsm("out.mjs", `{\n${pinned}\n}`), /emitted ESM/u);
    assert.throws(() => assertStaticEmittedEsm("out.mjs", `${pinned}\n${helper}`), /emitted ESM/u);
    for (const output of [
      "import './left-over.mjs';", "export * from 'pkg';", "import(x);", "import('node:crypto');", "const x = require('pkg');", "const x = __require('pkg');",
      "const x = createRequire(import.meta.url);", "const x = __commonJSRequire(() => {});",
      "const x = before__commonJS(() => {});", "const x = __commonJS2(() => {});", "const x = globalThis['require']('pkg');", "const x = module.require('pkg');",
      "const x = globalThis.require?.('pkg');", "const x = module['require']?.('pkg');"
    ]) assert.throws(() => assertStaticEmittedEsm("out.mjs", output), /emitted ESM/u);
    const noInitializer = changed({ ...clonePolicy(), emitted: { ...clonePolicy().emitted, commonJsInitializerIdentifiers: [] } });
    assert.throws(() => assertStaticEmittedEsm("out.mjs", callOnly, noInitializer), /unrecognized/u);
    const closedCopied = changed({
      ...clonePolicy(),
      emitted: {
        ...clonePolicy().emitted,
        commonJsInitializerIdentifiers: ["__closedCJS"]
      }
    });
    assert.doesNotThrow(() => assertStaticEmittedEsm("out.mjs", pinned.replaceAll("__commonJS", "__closedCJS"), closedCopied));
    for (const output of [
      "var x = __commonJS(() => {});",
      "var x = __commonJSRequire(() => {});",
      "var x = __commonJS2(() => {});",
      "var x = __closedCJSRequire(() => {});"
    ]) {
      assert.throws(() => assertStaticEmittedEsm("out.mjs", output, closedCopied), /emitted ESM/u);
    }
    const reservedCopied = changed({
      ...clonePolicy(),
      emitted: {
        ...clonePolicy().emitted,
        commonJsInitializerIdentifiers: ["__closedCJS"],
        commonJsReservedIdentifierPattern: "__retiredCJS"
      }
    });
    assert.throws(() => assertStaticEmittedEsm("out.mjs", "var x = __retiredCJS2(() => {});", reservedCopied), /emitted ESM/u);
    assert.throws(() => assertStaticEmittedEsm("out.mjs", "var x = __commonJS;"), /emitted ESM/u);
    assert.throws(() => assertStaticEmittedEsm("out.mjs", "const helper = __commonJS; var x = helper({ 'x.js'(exports, module) { exports.value = 1; } });"), /emitted ESM/u);
    assert.throws(() => assertStaticEmittedEsm("out.mjs", "var x = __commonJS(123);"), /emitted ESM/u);
    assert.throws(() => assertStaticEmittedEsm("out.mjs", "var x = __commonJS?.({ 'x.js'(exports, module) { exports.value = 1; } });"), /emitted ESM/u);
    assert.throws(() => assertStaticEmittedEsm("out.mjs", `${pinned}\nvar require_x = __commonJS?.({ 'x.js'(exports, module) { exports.value = 1; } });`), /emitted ESM/u);
    assert.throws(() => assertStaticEmittedEsm("out.mjs", `${pinned.replace("mod.exports", "mod")}\nvar require_x = __commonJS({ 'x.js'(exports, module) { exports.value = 1; } });`), /emitted ESM/u);
    assert.throws(() => assertStaticEmittedEsm("out.mjs", `${pinned.replace(", mod.exports", "")}\nvar require_x = __commonJS({ 'x.js'(exports, module) { exports.value = 1; } });`), /emitted ESM/u);
    assert.throws(() => assertStaticEmittedEsm("out.mjs", `${pinned.replace("}).exports, mod", "}).exports")}\nvar require_x = __commonJS({ 'x.js'(exports, module) { exports.value = 1; } });`), /emitted ESM/u);
    assert.throws(() => assertStaticEmittedEsm("out.mjs", "var x = globalThis.__commonJS({ 'x.js'(exports, module) { exports.value = 1; } });"), /emitted ESM/u);
    assert.throws(() => assertStaticEmittedEsm("out.mjs", "var x = __commonJS({ 'x.js'(exports, module) { exports.value = 1; } });"), /emitted ESM/u);
    assert.throws(() => assertStaticEmittedEsm("out.mjs", pinned.replace(/var __getOwnPropNames[\s\S]*?var __commonJS/u, "var __commonJS")), /emitted ESM/u);
    const resolverCopy = changed({ ...clonePolicy(), emitted: { ...clonePolicy().emitted, resolverIdentifiers: [...clonePolicy().emitted.resolverIdentifiers, "globalThis"] } });
    assert.throws(() => assertStaticEmittedEsm("out.mjs", "const x = globalThis.createRequire('pkg');", resolverCopy), /host resolver/u);
    const noDynamicImport = changed({ ...clonePolicy(), emitted: { ...clonePolicy().emitted, dynamicImport: "other" } });
    assert.throws(() => assertStaticEmittedEsm("out.mjs", "export {};", noDynamicImport), /dynamic import policy/u);
  });

  it("parses only marker-bearing authored text without evaluating it", () => {
    const marker = "__SIMFILE_STATIC_POLICY_MARKER__";
    const source = `globalThis[${JSON.stringify(marker)}] = true; export const value = 1;`;
    delete (globalThis as Record<string, unknown>)[marker];
    assertStaticSource("source.mjs", source);
    assert.equal((globalThis as Record<string, unknown>)[marker], undefined);
  });
});
