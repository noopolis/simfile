import assert from "node:assert/strict";
import { access, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import ts from "typescript";

import { ensurePublicPackageBuild } from "../publicPackageBuild.test-helper.js";
import { parseSimfileSource } from "../schema/parse.js";
import { loadDynamicsSession, parseWorldSurfaceDefinition } from "./index.js";
import * as dynamics from "./index.js";

const fixtureRoot = path.resolve(
  fileURLToPath(new URL("../../fixtures/sims/public-dynamics-contract/", import.meta.url))
);
const simfilePath = path.join(fixtureRoot, "Simfile");
const contractPath = path.join(fixtureRoot, "systems", "contract.ts");
const runtimeContractPath = path.join(fixtureRoot, "systems", "runtime-contract.ts");
const packageRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const fixtureSystemsPath = path.join(fixtureRoot, "systems");
const tscPath = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc");
const execFileAsync = promisify(execFile);

type ContractModule = {
  createDynamicsProvider: () => { id: string };
  createWorldSurfaceDefinition: () => unknown;
};

const loadContract = async (): Promise<ContractModule> =>
  import(pathToFileURL(contractPath).href) as Promise<ContractModule>;

const publicTypes = [
  "DynamicsActionAttempt",
  "DynamicsActionIngressEvidence",
  "DynamicsActionQueueReceipt",
  "DynamicsActionResolution",
  "DynamicsActionResult",
  "DynamicsBuildArtifactLifecycle",
  "DynamicsCommitmentOutcomeDraft",
  "DynamicsEvent",
  "DynamicsEventDraft",
  "DynamicsJsonObject",
  "DynamicsJsonValue",
  "DynamicsObservation",
  "DynamicsObservationChannel",
  "DynamicsObservationRequest",
  "DynamicsProvenance",
  "DynamicsProvider",
  "DynamicsProviderObservation",
  "DynamicsRunActionSourceInitialization",
  "DynamicsRunActionSourceTick",
  "DynamicsRunControllerAction",
  "DynamicsSession",
  "DynamicsSessionSnapshot",
  "DynamicsSpatialFrame",
  "DynamicsStepResult",
  "PreparedDynamicsBuild",
  "ReadonlyDynamicsJsonObject",
  "WorldAffordanceLoweringInput",
  "WorldMechanicsResult",
  "WorldSenseProjectionInput",
  "WorldSurfaceDefinition"
].sort();

const addedPublicTypes = [
  "DynamicsBuildArtifactLifecycle",
  "PreparedDynamicsBuild"
].sort();

const addedPublicRuntimeValues = [
  "canonicalDynamicsJson",
  "parseDynamicsActionAttempt",
  "parseDynamicsProvenance",
  "createDynamicsBuildReceipt",
  "parseDynamicsSessionSnapshot",
  "persistDynamicsBuild",
  "prepareDynamicsBuild"
].sort();

const existingPublicRuntimeValues = [
  "DYNAMICS_OBSERVATION_VERSION",
  "DYNAMICS_PROVIDER_API_VERSION",
  "DYNAMICS_SNAPSHOT_VERSION",
  "loadDynamicsSession"
].sort();

const publicDynamicsSpecifier = "simfile/dynamics";
type FixtureSourceClass = "shipped system module" | "fixture test";

const publicImportNames = (
  source: string,
  sourcePath: string,
  sourceClass: FixtureSourceClass = "shipped system module"
): string[] => {
  const parsed = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.ES2023, true);
  const names: string[] = [];
  const permittedExternalSpecifiers = new Set(["matter-js", "node:crypto", publicDynamicsSpecifier]);
  const assertFixtureSpecifier = (specifier: string): void => {
    const normalized = path.posix.normalize(specifier);
    if (sourceClass === "shipped system module") {
      assert.ok(
        (specifier.startsWith("./") && !normalized.startsWith("../"))
          || permittedExternalSpecifiers.has(specifier),
        `${sourcePath}: ${sourceClass} may not import private Simfile paths (${specifier})`
      );
      return;
    }
    const segments = specifier.split("/");
    const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
    const relativeToFixtureRoot = path.relative(
      fixtureRoot,
      path.resolve(path.dirname(sourcePath), specifier)
    );
    const staysInsideFixture = isRelative
      && relativeToFixtureRoot !== ".."
      && !relativeToFixtureRoot.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relativeToFixtureRoot);
    const isPublicPackageImport = !segments.includes("src")
      && (
        specifier.startsWith("node:")
        || specifier === "matter-js"
        || specifier === "simfile"
        || specifier.startsWith("simfile/")
      );
    assert.ok(
      staysInsideFixture || isPublicPackageImport,
      `${sourcePath}: ${sourceClass} may not import private Simfile paths (${specifier})`
    );
  };
  const assertNoRuntimePublicImport = (specifier: string, form: string): void => {
    assertFixtureSpecifier(specifier);
    if (sourceClass === "shipped system module") {
      assert.notEqual(specifier, publicDynamicsSpecifier, `${sourcePath}: ${sourceClass} must use import type declarations for ${publicDynamicsSpecifier}, not ${form}`);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      assert.ok(ts.isStringLiteral(node.moduleSpecifier), `${sourcePath}: ${sourceClass} imports require a string specifier`);
      const specifier = node.moduleSpecifier.text;
      assertFixtureSpecifier(specifier);
      if (sourceClass === "shipped system module" && specifier === publicDynamicsSpecifier) {
        assert.ok(node.importClause?.isTypeOnly, `${sourcePath}: ${sourceClass} ${publicDynamicsSpecifier} import must be type-only`);
        assert.ok(
          node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings),
          `${sourcePath}: ${sourceClass} ${publicDynamicsSpecifier} import must use named public types`
        );
        for (const element of node.importClause.namedBindings.elements) {
          assert.equal(element.propertyName, undefined, `${sourcePath}: ${sourceClass} public types may not be aliased`);
          names.push(element.name.text);
        }
      }
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      assert.ok(ts.isStringLiteral(node.moduleSpecifier), `${sourcePath}: ${sourceClass} exports require a string specifier`);
      assertNoRuntimePublicImport(node.moduleSpecifier.text, "export-from");
    }
    if (ts.isImportEqualsDeclaration(node)) {
      assert.ok(ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression), `${sourcePath}: ${sourceClass} import-equals is not permitted`);
      assertNoRuntimePublicImport(node.moduleReference.expression.text, "import-equals/require");
    }
    if (ts.isImportTypeNode(node)) {
      assert.ok(
        ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal),
        `${sourcePath}: ${sourceClass} import types require a string specifier`
      );
      const specifier = node.argument.literal.text;
      assertFixtureSpecifier(specifier);
      if (sourceClass === "shipped system module") {
        assert.notEqual(specifier, publicDynamicsSpecifier, `${sourcePath}: ${sourceClass} public types must use import type declarations`);
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      assert.ok(
        node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]),
        `${sourcePath}: ${sourceClass} dynamic imports require exactly one string specifier`
      );
      assertNoRuntimePublicImport(node.arguments[0].text, "dynamic import");
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      assert.ok(
        node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]),
        `${sourcePath}: ${sourceClass} require calls require exactly one string specifier`
      );
      assertNoRuntimePublicImport(node.arguments[0].text, "require");
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return names.sort();
};

const publicRuntimeImportNames = (source: string, sourcePath: string): string[] => {
  const parsed = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.ES2023, true);
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      assert.equal(node.moduleSpecifier.text, publicDynamicsSpecifier, `${sourcePath}: runtime imports must use ${publicDynamicsSpecifier}`);
      assert.equal(node.importClause?.isTypeOnly, false, `${sourcePath}: runtime imports must not be type-only`);
      assert.ok(node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings), `${sourcePath}: runtime imports must be named`);
      for (const element of (node.importClause.namedBindings as ts.NamedImports).elements) {
        assert.equal(element.propertyName, undefined, `${sourcePath}: runtime imports may not be aliased`);
        names.push(element.name.text);
      }
    }
    if (ts.isImportTypeNode(node) || ts.isImportEqualsDeclaration(node)) {
      assert.fail(`${sourcePath}: runtime contract may not use private type or require import forms`);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      assert.fail(`${sourcePath}: runtime contract may not use dynamic import or require`);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return names.sort();
};

describe("public dynamics contract fixture", () => {
  it("uses only the erased public type surface and a neutral provider", async () => {
    const source = await readFile(contractPath, "utf8");
    const imported = source.match(/import type \{([\s\S]+?)\} from "simfile\/dynamics";/u);
    assert.ok(imported);
    assert.deepEqual(imported[1].split(",").map((name) => name.trim()).filter(Boolean).sort(), publicTypes);
    assert.doesNotMatch(source, /football|matter-js|tiny-football/iu);
    assert.doesNotMatch(source, /from "(?:\.\/|\.\.\/|.*\/src\/)/u);
  });

  it("permits only the seven audited runtime additions without private source paths", async () => {
    const source = await readFile(runtimeContractPath, "utf8");
    assert.doesNotMatch(source, /football|matter-js|tiny-football|(?:\.\.\/|\/src\/)/iu);
    assert.deepEqual(publicRuntimeImportNames(source, runtimeContractPath), addedPublicRuntimeValues);
  });

  it("keeps pre-existing runtime exports separate from the audited additions", () => {
    for (const name of existingPublicRuntimeValues) {
      assert.ok(name in dynamics, `${name} must remain public`);
    }
  });

  it("adds only the two audited non-wire types to the dynamics barrel", async () => {
    const source = await readFile(path.join(packageRoot, "src", "dynamics", "index.ts"), "utf8");
    assert.deepEqual(
      [...source.matchAll(/type (DynamicsBuildArtifactLifecycle|PreparedDynamicsBuild)/gu)].map((match) => match[1]).sort(),
      addedPublicTypes
    );
    assert.doesNotMatch(source, /type (?:DynamicsBuildArtifactEvidence|PersistDynamicsBuildOptions|DynamicsBuildReceipt(?:Payload|RuntimeIdentity)?)/u);
  });

  it("rejects import forms that could bypass the public dynamics boundary", () => {
    const privateImportType = "type Private = import(\"../src/dynamics/index.js\").DynamicsProvider;";
    const computedDynamicImport = "import(\"simfile/\" + \"dynamics\");";
    const multiArgumentDynamicImport = "import(\"simfile/dynamics\", { with: {} });";
    const computedRequire = "require(\"simfile/\" + \"dynamics\");";
    const multiArgumentRequire = "require(\"simfile/dynamics\", {});";
    const fixtureTestPath = path.join(fixtureSystemsPath, "synthetic-fixture.test.ts");

    assert.throws(
      () => publicImportNames(privateImportType, "private-import-type.ts"),
      /may not import private Simfile paths/u
    );
    for (const source of [
      'import x from "../../src/dynamics/index.js";',
      'import x from "../../../outside.js";',
      'import x from "simfile/src/dynamics/index.js";',
      'type X = import("simfile/src/dynamics/index.js").DynamicsProvider;'
    ]) {
      assert.throws(
        () => publicImportNames(source, fixtureTestPath, "fixture test"),
        /synthetic-fixture\.test\.ts: fixture test may not import private Simfile paths/u
      );
    }
    for (const source of [
      'import assert from "node:assert/strict";',
      'import { parseWorldSurfaceDefinition } from "simfile";',
      'import { loadDynamicsSession } from "simfile/dynamics";',
      'import { x } from "../platform/dynamics/footballSession.test-helper.js";',
      'import { x } from "./vendor/pinned-package/src/runtime.js";'
    ]) {
      assert.deepEqual(publicImportNames(source, fixtureTestPath, "fixture test"), []);
    }
    for (const source of [
      'import assert from "node:assert/strict";',
      'import { parseWorldSurfaceDefinition } from "simfile";',
      'import { loadDynamicsSession } from "simfile/dynamics";'
    ]) {
      assert.throws(
        () => publicImportNames(source, "synthetic-system.ts"),
        /synthetic-system\.ts: shipped system module/u
      );
    }
    for (const [source, sourcePath, form] of [
      [computedDynamicImport, "computed-dynamic-import.ts", "dynamic imports"],
      [multiArgumentDynamicImport, "multi-argument-dynamic-import.ts", "dynamic imports"],
      [computedRequire, "computed-require.ts", "require calls"],
      [multiArgumentRequire, "multi-argument-require.ts", "require calls"]
    ] as const) {
      assert.throws(() => publicImportNames(source, sourcePath), new RegExp(`${form} require exactly one string specifier`, "u"));
    }
  });

  it("typechecks type-only and runtime external consumers with the expected emission modes", async () => {
    const outputDirectory = await mkdtemp(path.join(packageRoot, ".tmp-public-contract-"));
    try {
      await ensurePublicPackageBuild(packageRoot);
      await execFileAsync(process.execPath, [
        tscPath,
        "--pretty", "false",
        "--target", "ES2023",
        "--module", "NodeNext",
        "--moduleResolution", "NodeNext",
        "--strict",
        "--skipLibCheck",
        "--types", "node",
        "--rootDir", path.dirname(contractPath),
        "--outDir", outputDirectory,
        contractPath,
        runtimeContractPath
      ], { cwd: packageRoot });

      const emitted = await readFile(path.join(outputDirectory, "contract.js"), "utf8");
      assert.doesNotMatch(
        emitted,
        /(?:from\s*["']simfile(?:\/dynamics)?["']|import\(\s*["']simfile(?:\/dynamics)?["']\s*\)|require\(\s*["']simfile(?:\/dynamics)?["']\s*\))/u
      );
      const runtimeEmitted = await readFile(path.join(outputDirectory, "runtime-contract.js"), "utf8");
      assert.match(runtimeEmitted, /from\s*["']simfile\/dynamics["']/u);
    } finally {
      await rm(outputDirectory, { force: true, recursive: true });
    }
  });

  it("executes every audited runtime API through a physical development-package dynamics export", async () => {
    const consumerRoot = await realpath(await mkdtemp(path.join(tmpdir(), "simfile-dynamics-consumer-")));
    try {
      await ensurePublicPackageBuild(packageRoot);
      const installedPackageRoot = path.join(consumerRoot, "node_modules", "simfile");
      await mkdir(installedPackageRoot, { recursive: true });
      await Promise.all([
        cp(path.join(packageRoot, "dist"), path.join(installedPackageRoot, "dist"), { dereference: true, recursive: true }),
        cp(path.join(packageRoot, "package.json"), path.join(installedPackageRoot, "package.json"), { dereference: true }),
        cp(path.join(packageRoot, "package-lock.json"), path.join(installedPackageRoot, "package-lock.json"), { dereference: true })
      ]);
      assert.equal((await lstat(installedPackageRoot)).isSymbolicLink(), false, "development consumer package must not be a symlink");
      assert.notEqual(await realpath(installedPackageRoot), packageRoot, "development consumer package must not resolve to the workspace");
      const installedManifest = JSON.parse(await readFile(path.join(installedPackageRoot, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      assert.equal(installedManifest.dependencies?.typescript, "5.9.3", "development package must declare runtime TypeScript");
      assert.equal(installedManifest.dependencies?.esbuild, "0.28.1", "development package must declare runtime esbuild");
      const copyRuntimePackage = async (specifier: string, nodeModulesRoot: string): Promise<void> => {
        const target = path.join(nodeModulesRoot, specifier);
        await mkdir(path.dirname(target), { recursive: true });
        await cp(path.join(packageRoot, "node_modules", specifier), target, { dereference: true, recursive: true });
      };
      await Promise.all([
        "typescript",
        "esbuild",
        "@esbuild",
        "zod",
        "yaml",
        "@types/node",
        "undici-types"
      ].map((specifier) => copyRuntimePackage(specifier, path.join(installedPackageRoot, "node_modules"))));
      await Promise.all([
        "typescript",
        "@types/node",
        "undici-types"
      ].map((specifier) => copyRuntimePackage(specifier, path.join(consumerRoot, "node_modules"))));
      await writeFile(path.join(consumerRoot, "package.json"), '{"name":"external-consumer","private":true,"type":"module","version":"1.0.0"}\n');
      const externalFixtureRoot = path.join(consumerRoot, "fixture");
      await mkdir(path.join(externalFixtureRoot, "systems"), { recursive: true });
      await writeFile(path.join(externalFixtureRoot, "Simfile"), await readFile(simfilePath));
      await writeFile(path.join(externalFixtureRoot, "systems", "provider.mjs"), [
        "export const createDynamicsProvider = () => ({",
        '  api_version: "simfile.dynamics-provider.v1",',
        '  id: "external-public-contract",',
        '  version: "1.0.0",',
        '  state_schema_version: "external-public-contract.v1",',
        "  initialize() {},",
        "  observe() { return { channels: [] }; },",
        "  restore() {},",
        "  snapshot() { return {}; },",
        "  /** @param {{ tick: number }} input */",
        "  step(input) { return { action_results: [], events: [], tick: input.tick }; }",
        "});"
      ].join("\n"));
      const scratchRoot = path.join(consumerRoot, "scratch");
      const evidenceRoot = path.join(consumerRoot, "evidence");
      await mkdir(scratchRoot);
      await mkdir(evidenceRoot);

      const externalRuntimeContract = path.join(consumerRoot, "runtime-contract.mts");
      await writeFile(externalRuntimeContract, await readFile(runtimeContractPath));
      const outputDirectory = path.join(consumerRoot, "out");
      await execFileAsync(process.execPath, [
        path.join(consumerRoot, "node_modules", "typescript", "bin", "tsc"),
        "--pretty", "false",
        "--target", "ES2023",
        "--module", "NodeNext",
        "--moduleResolution", "NodeNext",
        "--strict",
        "--skipLibCheck",
        "--types", "node",
        "--rootDir", consumerRoot,
        "--outDir", outputDirectory,
        externalRuntimeContract
      ], { cwd: consumerRoot });

      const consumerPath = path.join(consumerRoot, "consumer.mjs");
      await writeFile(consumerPath, [
        'import assert from "node:assert/strict";',
        'import { access } from "node:fs/promises";',
        'import { exercisePublicDynamicsRuntime } from "./out/runtime-contract.mjs";',
        `const paths = await exercisePublicDynamicsRuntime(${JSON.stringify({
          evidenceRoot,
          moduleReference: "./systems/provider.mjs",
          scratchRoot,
          simfilePath: path.join(externalFixtureRoot, "Simfile")
        })});`,
        'await assert.rejects(() => access(paths.artifactPath), { code: "ENOENT" });',
        'await assert.rejects(() => access(paths.receiptPath), { code: "ENOENT" });',
        'await access(paths.evidenceArtifactPath);',
        'await access(paths.evidenceReceiptPath);',
        'for (const specifier of ["simfile/dynamics/build", "simfile/dynamics/validation", "simfile/src/dynamics/index.js"]) {',
        '  await assert.rejects(import(specifier), (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED");',
        '}'
      ].join("\n"));
      await execFileAsync(process.execPath, [consumerPath], { cwd: consumerRoot });
    } finally {
      await rm(consumerRoot, { force: true, recursive: true });
    }
  });

  it("loads the public provider and parses its public world surface without stepping", async () => {
    const parsed = parseSimfileSource(await readFile(simfilePath, "utf8"), { path: simfilePath }).simfile;
    const session = await loadDynamicsSession(parsed, { simfilePath });
    assert.ok(session);
    assert.equal(session.provenance.provider_id, "public-contract-counter");
    assert.equal(session.nextTick, 0);

    const contract = await loadContract();
    const surface = parseWorldSurfaceDefinition(contract.createWorldSurfaceDefinition());
    assert.deepEqual(surface.entities.map(({ address }) => address), ["entity:counter"]);
    assert.deepEqual(surface.senses.map(({ address }) => address), ["sense:counter"]);
    assert.deepEqual(surface.affordances.map(({ address }) => address), ["affordance:increment"]);
    assert.equal(contract.createDynamicsProvider().id, "public-contract-counter");
  });
});
