import assert from "node:assert/strict";
import test from "node:test";

import {
  collectPublicImportSymbols,
  discoverRelativeDependencies,
  expressionHash,
  type ComputedDynamicDependencyException,
  type PublicImports,
} from "./fixtureDependencyScanner.test-helper.js";

test("public dependency scanner rejects every unsupported relative dependency form", () => {
  const consumer = "src/sims/scenarioProbe.ts";
  const candidates = new Set([consumer, "src/dynamics/types.ts"]);
  const providers = new Map([["src/dynamics/types.ts", "simfile/dynamics"]]);
  const reject = (source: string, pattern: RegExp) => {
    assert.deepEqual(discoverRelativeDependencies(source, consumer, candidates), ["src/dynamics/types.ts"]);
    assert.throws(() => collectPublicImportSymbols(source, consumer, candidates, providers, new Map()), pattern);
  };
  const accepted: PublicImports = new Map();
  collectPublicImportSymbols('import type { DynamicsSession as Session } from "../dynamics/types.js";', consumer, candidates, providers, accepted);
  assert.deepEqual([...accepted.get("simfile/dynamics")!.types], ["DynamicsSession"]);
  assert.deepEqual(discoverRelativeDependencies('import "../dynamics/types";', consumer, candidates), ["src/dynamics/types.ts"]);
  assert.deepEqual(discoverRelativeDependencies('import "../dynamics/types.mjs";', consumer, candidates), ["src/dynamics/types.ts"]);
  reject('import {} from "../dynamics/types.js";', /default, namespace, or side-effect/u);
  reject('import { default as Session } from "../dynamics/types.js";', /unproved default import specifier/u);
  reject('export { DynamicsSession } from "../dynamics/types.js";', /unproved export-from/u);
  reject('export * from "../dynamics/types.js";', /unproved export-from/u);
  reject('import type Session = require("../dynamics/types.js");', /unproved import-equals/u);
  reject('import Session from "../dynamics/types.js";', /default, namespace, or side-effect/u);
  reject('import * as dynamics from "../dynamics/types.js";', /default, namespace, or side-effect/u);
  reject('void import("../dynamics/types.js");', /unproved dynamic dependency/u);
  reject('require("../dynamics/types.js");', /unproved dynamic dependency/u);
  reject('const direct = require; const transitive = (0, direct); transitive("../dynamics/types.js");', /unproved dynamic dependency/u);
  reject('require("../dynamics/types.js", options);', /multi-argument dynamic dependency/u);
  const rejectComputed = (source: string) => {
    assert.deepEqual(discoverRelativeDependencies(source, consumer, candidates), []);
    assert.throws(() => collectPublicImportSymbols(source, consumer, candidates, providers, new Map()), /unproved nonliteral dynamic dependency/u);
  };
  rejectComputed('void import("../dynamics/" + "types.js");');
  rejectComputed('require("../dynamics/" + "types.js");');
  rejectComputed('(0, require)("../dynamics/" + "types.js");');
  rejectComputed('const direct = require; const transitive = (0, direct); (transitive)("../dynamics/" + "types.js");');
  rejectComputed('(require.call)(null, "../dynamics/" + "types.js");');
  rejectComputed('require["apply"](null, ["../dynamics/" + "types.js"]);');
  rejectComputed('const call = require.call; call(null, "../dynamics/" + "types.js");');
  rejectComputed('const apply = require.apply; const transitive = apply; transitive(null, ["../dynamics/" + "types.js"]);');
  for (const escapedRequire of [
    'const pass = (value: unknown) => value; const escaped = pass(require); escaped("../dynamics/types.js");',
    'const escaped = { require }; escaped.require("../dynamics/types.js");',
    'const direct = require; const escaped = [direct]; escaped[0]("../dynamics/types.js");',
    'const call = require.call; const escaped = { call }; escaped.call(null, "../dynamics/types.js");'
  ]) assert.throws(() => collectPublicImportSymbols(escapedRequire, consumer, candidates, providers, new Map()), /unproved require reference/u);
  assert.throws(() => collectPublicImportSymbols('import("../dynamics/" + "types.js", { with: {} });', consumer, candidates, providers, new Map()), /multi-argument dynamic dependency/u);
});

test("computed dynamic dependency exceptions are exact AST proofs", () => {
  const consumer = "fixtures/sims/reference-game/platform/dynamics/session.test-helper.ts";
  const source = 'void import(`${pathToFileURL(PROVIDER_MODULE).href}?fixed_test=${Date.now()}-${Math.random()}`);';
  const normalized = '`${pathToFileURL(PROVIDER_MODULE).href}?fixed_test=${Date.now()}-${Math.random()}`';
  const exception: ComputedDynamicDependencyException = {
    path: consumer, call: "import", dynamic_call_ordinal: 1,
    normalized_expression: normalized,
    normalized_expression_sha256: expressionHash(normalized),
    purpose: "reload fixture-owned provider module",
  };
  const used = new Map<ComputedDynamicDependencyException, number>();
  const collect = (candidate: string, exceptions = [exception], usage = new Map<ComputedDynamicDependencyException, number>()) =>
    collectPublicImportSymbols(candidate, consumer, new Set([consumer]), new Map(), new Map(), exceptions, usage);
  collect(source, [exception], used);
  assert.equal(used.get(exception), 1);
  assert.throws(() => collect(source.replace("Math.random()", "Math.random() + 1")), /unproved nonliteral dynamic dependency/u);
  assert.throws(() => collect(`${source}\n${source}`), /unproved nonliteral dynamic dependency/u);
  assert.throws(() => collect(`${source.slice(0, -2)}, { with: {} });`), /multi-argument dynamic dependency/u);
  for (const hostileRequire of [
    'require(`${pathToFileURL(PROVIDER_MODULE).href}`);',
    '(require)(`${pathToFileURL(PROVIDER_MODULE).href}`);',
    'const r = require; r(`${pathToFileURL(PROVIDER_MODULE).href}`);',
    'const call = require.call; call(null, `${pathToFileURL(PROVIDER_MODULE).href}`);',
    'const apply = require.apply; const delegated = apply; delegated(null, [`${pathToFileURL(PROVIDER_MODULE).href}`]);',
  ]) assert.throws(() => collect(hostileRequire), /unproved nonliteral dynamic dependency/u);
  assert.throws(() => collect('const pass = (value: unknown) => value; const escaped = pass(require); escaped(`${pathToFileURL(PROVIDER_MODULE).href}`);'), /unproved require reference/u);
});
