/**
 * Accident ratchet over src/run/ production sources, not a security boundary
 * and not a claim about deliberate evasion. The production scan is recursive
 * over src/run/. The walk does not follow directory symlinks, so it terminates;
 * code reachable only through a symlinked directory is out of model. It catches
 * ordinary global capability use, off-list imports, enumeration, clocks, timers,
 * and unsafe buffer allocation.
 *
 * Syntactically recognized participant-hook calls named onTick, notify,
 * awaitParticipant, nextParticipant, runParticipantTurn, or pollParticipant
 * may appear only as discarded expression statements. This hook rule is
 * syntactic: laundering through an alias (`const fn = host.notify; await
 * fn();`), dynamic dispatch, an ambient declaration, or a differently named
 * wrapper remains out of model. Type-only aliases plus @ts-ignore, Object
 * constructor recovery, and allowlisted reads from device paths can also
 * bypass this scan. Review and artifact-level determinism tests are the
 * backstops for those named risks and for the unscanned seam closure.
 */
import assert from "node:assert/strict";
import {
  mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const runRoot = fileURLToPath(new URL("./", import.meta.url));

const permittedFreeNames = new Set([
  "AggregateError", "Array", "BigInt", "Boolean", "Buffer", "Date", "Error", "Infinity", "JSON",
  "Map", "Math", "NaN", "Number", "Object", "Promise", "RangeError", "Set",
  "String", "Symbol", "TypeError", "undefined"
]);

const permittedModules = new Set([
  "node:fs/promises", "node:path", "node:os", "node:crypto", "node:string_decoder",
  "./dynamics-run-record.js", "./dynamics-run-artifacts.js",
  "./dynamics-run-actions.js", "./dynamics-run-action-source.js",
  "./dynamics-run-action-ticks.js", "./dynamics-run-action-causes.js",
  "./dynamics-run-commitment-outcomes.js",
  "./dynamics-run-contract-versions.js", "./dynamics-run-replay.js",
  "./dynamics-run-frames.js", "../runtime/trace.js",
  "../dynamics/loadRunActionSource.js",
  "../dynamics/runActionSource.js", "../dynamics/canonicalJson.js",
  "../dynamics/session.js", "../dynamics/types.js",
  "../dynamics/buildReceipt.js", "../world/controllerAuthority.js",
  "../world/clockAuthority.js", "../world/actEnvelope.js", "../world/actTypes.js",
  "../world/actionRefusalJournal.js",
  "../world/actionJournalInspection.js", "../world/ledger.js",
  "./world-grant-run.js", "../world/grantComposition.js", "../world/runtimeComposition.js",
  "../world/observe.js", "../world/runtime.js", "../world-surface/index.js",
  "../dynamics/validation.js",
  "./dynamics-run-world-evidence.js",
  "../ledger/principal.js", "../ledger/stable.js", "../ledger/validation.js",
  "../observe/manifest.js", "../runtime/types.js", "../schema/model.js",
  "../viewer-extension/projectDeclaration.js"
]);

const externalBindings = new Map<string, ReadonlySet<string>>([
  ["node:fs/promises", new Set([
    "mkdir", "mkdtemp", "open", "readFile", "realpath", "rename", "rm", "rmdir"
  ])],
  ["node:path", new Set(["basename", "dirname", "join"])],
  ["node:os", new Set(["tmpdir"])],
  ["node:crypto", new Set(["createHash"])],
  ["node:string_decoder", new Set(["StringDecoder"])]
]);

const bannedNames = new Set([
  "readdir", "readdirSync", "opendir", "opendirSync", "glob", "globSync",
  "watch", "now", "random", "hrtime", "performance", "setTimeout",
  "setInterval", "setImmediate", "queueMicrotask", "observedAt", "resolve",
  "constructor", "prototype", "__proto__", "allocUnsafe", "allocUnsafeSlow",
  "awaitParticipant", "nextParticipant", "runParticipantTurn",
  "pollParticipant"
]);

const participantHookNames = new Set([
  "onTick", "notify", "awaitParticipant", "nextParticipant",
  "runParticipantTurn", "pollParticipant"
]);

const isBindingName = (identifier: ts.Identifier): boolean => {
  const parent = identifier.parent;
  return ts.isVariableDeclaration(parent) && parent.name === identifier
    || ts.isBindingElement(parent) && parent.name === identifier
    || ts.isParameter(parent) && parent.name === identifier
    || ts.isFunctionDeclaration(parent) && parent.name === identifier
    || ts.isFunctionExpression(parent) && parent.name === identifier
    || ts.isClassDeclaration(parent) && parent.name === identifier
    || ts.isClassExpression(parent) && parent.name === identifier
    || ts.isImportClause(parent) && parent.name === identifier
    || ts.isImportSpecifier(parent) && parent.name === identifier
    || ts.isNamespaceImport(parent) && parent.name === identifier
    || ts.isCatchClause(parent) && parent.variableDeclaration?.name === identifier;
};

const isTypePosition = (identifier: ts.Identifier): boolean => {
  let node: ts.Node = identifier;
  while (node.parent) {
    node = node.parent;
    if (ts.isTypeNode(node)) return true;
    if (ts.isExpression(node) || ts.isStatement(node)
      || ts.isSourceFile(node)) return false;
  }
  return false;
};

const isValueIdentifier = (identifier: ts.Identifier): boolean => {
  if (isBindingName(identifier) || isTypePosition(identifier)) return false;
  const parent = identifier.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) {
    return false;
  }
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)
    || ts.isPropertyDeclaration(parent)) && parent.name === identifier) {
    return false;
  }
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)
    || ts.isLabeledStatement(parent)
    || ts.isBreakOrContinueStatement(parent)) return false;
  return true;
};

const sourceProgram = (file: string, sourceText: string) => {
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2023
  };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile;
  host.getSourceFile = (name, languageVersion, onError, fresh) =>
    name === file
      ? ts.createSourceFile(file, sourceText, languageVersion, true)
      : originalGetSourceFile(name, languageVersion, onError, fresh);
  host.fileExists = ((original) => (name) =>
    name === file || original(name))(host.fileExists);
  host.readFile = ((original) => (name) =>
    name === file ? sourceText : original(name))(host.readFile);
  const program = ts.createProgram([file], options, host);
  const source = program.getSourceFile(file);
  if (!source) throw new Error(`failed to parse ${file}`);
  return { checker: program.getTypeChecker(), source };
};

const propertyText = (name: ts.PropertyName | ts.BindingName): string | undefined => {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)
    || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const expression = name.expression;
    if (ts.isIdentifier(expression) || ts.isStringLiteral(expression)
      || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  }
  return undefined;
};

const calleeContainsParticipantHook = (callee: ts.Expression): boolean => {
  let expression = callee;
  while (true) {
    if (ts.isParenthesizedExpression(expression)) {
      expression = expression.expression;
      continue;
    }
    if (ts.isIdentifier(expression)) {
      return participantHookNames.has(expression.text);
    }
    if (!ts.isPropertyAccessExpression(expression)) return false;
    if (participantHookNames.has(expression.name.text)) return true;
    expression = expression.expression;
  }
};

const isDiscardedExpressionStatement = (call: ts.CallExpression): boolean => {
  let expression: ts.Expression = call;
  while (ts.isParenthesizedExpression(expression.parent)) {
    expression = expression.parent;
  }
  return ts.isExpressionStatement(expression.parent)
    && expression.parent.expression === expression;
};

export const findRunDeterminismViolations = (
  sources: ReadonlyMap<string, string>
): string[] => {
  const violations: string[] = [];
  for (const [file, sourceText] of sources) {
    const { checker, source } = sourceProgram(file, sourceText);
    const report = (message: string): void => {
      violations.push(`${path.basename(file)}: ${message}`);
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportEqualsDeclaration(node)) report("import-equals");
      if (ts.isImportDeclaration(node)) {
        if (!ts.isStringLiteral(node.moduleSpecifier)) report("non-literal import");
        else {
          const module = node.moduleSpecifier.text;
          if (!permittedModules.has(module)) report(`off-list import ${module}`);
          const clause = node.importClause;
          if (!clause) report("side-effect import");
          if (clause?.name) report("default import");
          if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
            report("namespace import");
          }
          if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            for (const specifier of clause.namedBindings.elements) {
              const imported = (specifier.propertyName ?? specifier.name).text;
              const typeOnly = clause.isTypeOnly || specifier.isTypeOnly;
              if (!typeOnly && externalBindings.has(module)
                && !externalBindings.get(module)?.has(imported)) {
                report(`off-list binding ${module}:${imported}`);
              }
              if (!typeOnly && imported === "realpath"
                && path.basename(file) !== "dynamics-run-artifacts.ts") {
                report("realpath outside artifact writer");
              }
              if (bannedNames.has(imported)) report(`banned import ${imported}`);
            }
          }
        }
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        if (!ts.isStringLiteral(node.moduleSpecifier)
          || !permittedModules.has(node.moduleSpecifier.text)) {
          report("off-list re-export");
        }
        if (node.exportClause && ts.isNamespaceExport(node.exportClause)) {
          report("namespace re-export");
        }
      }
      if (ts.isCallExpression(node)
        && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        report("dynamic import");
      }
      if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression)) {
        const called = node.expression.expression;
        if (
          ts.isIdentifier(called)
            && ["onTick", "notify", "awaitParticipant"].includes(called.text)
          || ts.isPropertyAccessExpression(called)
            && ["onTick", "notify"].includes(called.name.text)
        ) {
          report("awaited participant action source");
        }
      }
      if (ts.isCallExpression(node)
        && calleeContainsParticipantHook(node.expression)
        && !isDiscardedExpressionStatement(node)) {
        report("consumed participant hook result");
      }
      if (ts.isElementAccessExpression(node)) {
        const argument = node.argumentExpression;
        if (argument && (ts.isStringLiteral(argument)
          || ts.isNoSubstitutionTemplateLiteral(argument)
          || ts.isTemplateExpression(argument))) report("string computed access");
      }
      if (ts.isPropertyAccessExpression(node) && bannedNames.has(node.name.text)) {
        report(`banned property ${node.name.text}`);
      }
      if (ts.isBindingElement(node)) {
        const name = propertyText(node.propertyName ?? node.name);
        if (name && bannedNames.has(name)) report(`banned binding ${name}`);
      }
      if (ts.isComputedPropertyName(node)) {
        const name = propertyText(node);
        if (name && bannedNames.has(name)) report(`banned computed name ${name}`);
      }
      if (ts.isIdentifier(node) && isValueIdentifier(node)) {
        const symbol = checker.getSymbolAtLocation(node);
        const locallyBound = symbol?.declarations?.some(
          (declaration) => declaration.getSourceFile() === source
        ) ?? false;
        if (!locallyBound && !permittedFreeNames.has(node.text)) {
          report(`free identifier ${node.text}`);
        }
        if (node.text === "Date") {
          const parent = node.parent;
          if (!ts.isNewExpression(parent) || parent.expression !== node
            || (parent.arguments?.length ?? 0) < 1) report("unsafe Date use");
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations;
};

export const collectProductionFiles = async (
  root: string
): Promise<string[]> => {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (
        entry.isFile()
        && entry.name.endsWith(".ts")
        && !entry.name.endsWith(".test.ts")
        && !entry.name.endsWith(".test-helper.ts")
      ) {
        files.push(entryPath);
      }
    }
  };
  await visit(path.resolve(root));
  return files.sort();
};

test("src/run production code stays inside the deterministic accident boundary", async () => {
  const files = await collectProductionFiles(runRoot);
  assert.ok(files.length > 0, "src/run scan found no production files");
  assert.equal(files.every((file) => file.startsWith(path.resolve(runRoot) + path.sep)), true);
  assert.equal(files.every((file) => !file.includes(`${path.sep}e2e${path.sep}`)), true);
  assert.equal(files.every((file) => file.endsWith(".ts")
    && !file.endsWith(".test.ts") && !file.endsWith(".test-helper.ts")), true);
  const sources = new Map(await Promise.all(files.map(async (file) =>
    [file, await readFile(file, "utf8")] as const
  )));
  assert.equal(sources.size, files.length, "scan source map size differs from file list");
  assert.deepEqual(findRunDeterminismViolations(sources), []);
});

test("production-file collection recursively includes only production TypeScript", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "simfile-run-scan-"));
  try {
    await mkdir(path.join(root, "sub", "deep"), { recursive: true });
    await Promise.all([
      writeFile(path.join(root, "a.ts"), ""),
      writeFile(path.join(root, "sub", "b.ts"), ""),
      writeFile(path.join(root, "sub", "deep", "c.ts"), ""),
      writeFile(path.join(root, "sub", "d.test.ts"), ""),
      writeFile(path.join(root, "sub", "e.test-helper.ts"), ""),
      writeFile(path.join(root, "sub", "f.md"), "")
    ]);
    await symlink(root, path.join(root, "sub", "deep", "cycle"), "dir");
    assert.deepEqual(await collectProductionFiles(root), [
      path.join(root, "a.ts"),
      path.join(root, "sub", "b.ts"),
      path.join(root, "sub", "deep", "c.ts")
    ].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hostile ordinary-use sources are rejected", () => {
  const cases = [
    `crypto.randomUUID(); crypto.getRandomValues(x);`,
    `fetch("http://x"); AbortSignal.timeout(1); structuredClone(x);`,
    `import { defaultSleep } from "../sims/poll.js"; defaultSleep();`,
    `import { x } from "../dynamics/testSupport.test-helper.js"; x();`,
    `globalThis["Date"]["now"]();`,
    `import fs from "node:fs/promises"; fs["readdir"](".");`,
    `const { readdir: list } = fs; list(".");`,
    `export * as io from "node:fs/promises";`,
    `import p from "path"; p["resolve"]("x");`,
    `import { scheduler } from "node:timers/promises"; scheduler.wait(1);`,
    `import { randomBytes, webcrypto } from "node:crypto";`,
    `const { now } = Date; now();`,
    `Buffer.allocUnsafe(8); const { allocUnsafeSlow: make } = Buffer;`,
    `import fs = require("node:fs"); fs.readFileSync("x");`,
    `await source.onTick(context);`,
    `await host.notify(0);`,
    `awaitParticipant();`,
    `async function f(host: any) { await Promise.all([host.notify()]); }`,
    `async function f(host: any) { await (host.notify()); }`,
    `async function f(host: any) { const p = host.notify(); await p; }`,
    `async function f(host: any) { await host.notify.call(host); }`,
    `async function f(host: any) { for await (const x of [host.onTick()]) {} }`,
    `function f(host: any) { return host.notify(); }`,
    `import { x } from "../../fixtures/sims/example/controller.js"; x();`,
    `import("./dynamic.js");`
  ];
  for (const [index, source] of cases.entries()) {
    assert.notDeepEqual(
      findRunDeterminismViolations(new Map([[`/hostile-${index}.ts`, source]])),
      [],
      source
    );
  }
});

test("a compliant source passes the accident boundary", () => {
  const source = `
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stableStringify } from "../ledger/stable.js";
export const digest = async (root: string) => {
  const bytes = await readFile(join(root, "x"));
  return createHash("sha256").update(bytes).digest("hex")
    + stableStringify({ at: new Date(0).toISOString(), first: bytes[0] });
};`;
  assert.deepEqual(
    findRunDeterminismViolations(new Map([["/compliant.ts", source]])),
    []
  );
});
