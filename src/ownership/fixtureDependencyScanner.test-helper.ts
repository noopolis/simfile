import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import ts from "typescript";

export interface ComputedDynamicDependencyException {
  readonly path: string;
  readonly call: "import" | "require";
  readonly dynamic_call_ordinal: number;
  readonly normalized_expression: string;
  readonly normalized_expression_sha256: string;
  readonly purpose: string;
}
export type PublicImports = Map<string, { values: Set<string>; types: Set<string> }>;
type DynamicCall = {
  call: "import" | "require";
  directRequire: boolean;
  argument: ts.Expression | undefined;
  argumentCount: number;
};
type RequireTaint = "require" | "call" | "apply";
type RequireAnalysis = {
  aliases: ReadonlyMap<string, RequireTaint>;
  dynamicCalls: ReadonlyMap<ts.CallExpression, DynamicCall>;
  allowedReferences: ReadonlySet<ts.Identifier>;
};
const extensions = [".ts", ".mts", ".cts", ".mjs", ".cjs", ".js"];

const normalizeExpression = (expression: ts.Expression, source: ts.SourceFile): string =>
  ts.createPrinter({ removeComments: true })
    .printNode(ts.EmitHint.Expression, expression, source).trim();
export const expressionHash = (expression: string): string =>
  createHash("sha256").update(expression).digest("hex");
const unparenthesized = (expression: ts.Expression): ts.Expression => {
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return expression;
};
const requireTaint = (
  expression: ts.Expression,
  aliases: ReadonlyMap<string, RequireTaint>,
): RequireTaint | undefined => {
  expression = unparenthesized(expression);
  if (ts.isBinaryExpression(expression)
    && expression.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return requireTaint(expression.right, aliases);
  }
  if (ts.isIdentifier(expression)) {
    return expression.text === "require" ? "require" : aliases.get(expression.text);
  }
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    if (requireTaint(expression.expression, aliases) !== "require") return undefined;
    const property = ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : expression.argumentExpression && ts.isStringLiteral(expression.argumentExpression)
        ? expression.argumentExpression.text : undefined;
    return property === "call" || property === "apply" ? property : undefined;
  }
  return undefined;
};
const aliasBindings = (source: ts.SourceFile): ReadonlyMap<string, RequireTaint> => {
  const aliases = new Map<string, RequireTaint>();
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const taint = requireTaint(node.initializer, aliases);
        if (taint && aliases.get(node.name.text) !== taint) {
          aliases.set(node.name.text, taint);
          changed = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return aliases;
};
const dynamicCall = (
  call: ts.CallExpression,
  aliases: ReadonlyMap<string, RequireTaint>,
): DynamicCall | undefined => {
  if (call.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return { call: "import", directRequire: true,
      argument: call.arguments[0], argumentCount: call.arguments.length };
  }
  const taint = requireTaint(unparenthesized(call.expression), aliases);
  if (taint === "require") return { call: "require", directRequire: true,
    argument: call.arguments[0], argumentCount: call.arguments.length };
  if (taint === "call") return { call: "require", directRequire: false,
    argument: call.arguments[1], argumentCount: Math.max(0, call.arguments.length - 1) };
  if (taint !== "apply") return undefined;
  const applied = call.arguments.length === 2 && ts.isArrayLiteralExpression(call.arguments[1])
    && call.arguments[1].elements.length === 1
    && ts.isExpression(call.arguments[1].elements[0])
    ? call.arguments[1].elements[0] : undefined;
  return { call: "require", directRequire: false, argument: applied,
    argumentCount: applied ? 1 : 0 };
};
const isBindingIdentifier = (identifier: ts.Identifier): boolean => {
  const { parent } = identifier;
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
    || ts.isImportEqualsDeclaration(parent) && parent.name === identifier
    || ts.isCatchClause(parent) && parent.variableDeclaration?.name === identifier;
};
const markTaintedReferences = (
  expression: ts.Expression,
  aliases: ReadonlyMap<string, RequireTaint>,
  allowed: Set<ts.Identifier>,
): void => {
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !isBindingIdentifier(node)
      && (node.text === "require" || aliases.has(node.text))) allowed.add(node);
    ts.forEachChild(node, visit);
  };
  visit(expression);
};
const requireAnalysis = (source: ts.SourceFile): RequireAnalysis => {
  const aliases = aliasBindings(source);
  const dynamicCalls = new Map<ts.CallExpression, DynamicCall>();
  const allowedReferences = new Set<ts.Identifier>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && requireTaint(node.initializer, aliases)) {
      markTaintedReferences(node.initializer, aliases, allowedReferences);
    }
    if (ts.isCallExpression(node)) {
      const dynamic = dynamicCall(node, aliases);
      if (dynamic) {
        dynamicCalls.set(node, dynamic);
        markTaintedReferences(node.expression, aliases, allowedReferences);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { aliases, dynamicCalls, allowedReferences };
};
const assertAllRequireReferencesAccounted = (
  source: ts.SourceFile,
  consumer: string,
  analysis: RequireAnalysis,
): void => {
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !isBindingIdentifier(node)
      && (node.text === "require" || analysis.aliases.has(node.text))) {
      assert.ok(analysis.allowedReferences.has(node),
        `${consumer} uses an unproved require reference`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
};
const resolveImport = (
  from: string,
  specifier: string,
  candidates: ReadonlySet<string>,
): string | undefined => {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  return [
    base,
    ...extensions.map((extension) => base.replace(/\.[^/.]+$/u, extension)),
    ...extensions.map((extension) => `${base}${extension}`),
    ...extensions.map((extension) => `${base}/index${extension}`),
  ].find((candidate) => candidates.has(candidate));
};

export const discoverRelativeDependencies = (
  sourceText: string,
  consumer: string,
  candidates: ReadonlySet<string>,
): string[] => {
  const source = ts.createSourceFile(consumer, sourceText, ts.ScriptTarget.Latest, true);
  const analysis = requireAnalysis(source);
  const dependencies = new Set<string>();
  const add = (literal: ts.Expression | undefined) => {
    if (literal && ts.isStringLiteral(literal)) {
      const resolved = resolveImport(consumer, literal.text, candidates);
      if (resolved) dependencies.add(resolved);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression);
    }
    if (ts.isCallExpression(node)) add(analysis.dynamicCalls.get(node)?.argument);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...dependencies].sort();
};

export const collectPublicImportSymbols = <T extends ComputedDynamicDependencyException>(
  sourceText: string,
  consumer: string,
  candidates: ReadonlySet<string>,
  providers: ReadonlyMap<string, string>,
  imports: PublicImports,
  computedExceptions: readonly T[] = [],
  usedComputedExceptions = new Map<T, number>(),
): void => {
  const source = ts.createSourceFile(consumer, sourceText, ts.ScriptTarget.Latest, true);
  const analysis = requireAnalysis(source);
  assertAllRequireReferencesAccounted(source, consumer, analysis);
  let dynamicCallOrdinal = 0;
  const mappedProvider = (specifier: string) => {
    if (!specifier.startsWith(".")) return undefined;
    const provider = resolveImport(consumer, specifier, candidates);
    return provider && providers.has(provider)
      ? { provider, publicSpecifier: providers.get(provider)! } : undefined;
  };
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const mapped = mappedProvider(statement.moduleSpecifier.text);
      if (!mapped) continue;
      assert.ok(statement.importClause && !statement.importClause.name
        && statement.importClause.namedBindings
        && ts.isNamedImports(statement.importClause.namedBindings)
        && statement.importClause.namedBindings.elements.length > 0,
      `${consumer} uses an unproved default, namespace, or side-effect import from ${mapped.provider}`);
      const group = imports.get(mapped.publicSpecifier)
        ?? { values: new Set<string>(), types: new Set<string>() };
      for (const element of statement.importClause.namedBindings.elements) {
        const exported = (element.propertyName ?? element.name).text;
        assert.notEqual(exported, "default",
          `${consumer} uses an unproved default import specifier from ${mapped.provider}`);
        (statement.importClause.isTypeOnly || element.isTypeOnly
          ? group.types : group.values).add(exported);
      }
      imports.set(mapped.publicSpecifier, group);
      continue;
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier
      && ts.isStringLiteral(statement.moduleSpecifier)) {
      const mapped = mappedProvider(statement.moduleSpecifier.text);
      assert.ok(!mapped, `${consumer} uses an unproved export-from dependency on ${mapped?.provider}`);
      continue;
    }
    if (ts.isImportEqualsDeclaration(statement)
      && ts.isExternalModuleReference(statement.moduleReference)
      && statement.moduleReference.expression
      && ts.isStringLiteral(statement.moduleReference.expression)) {
      const mapped = mappedProvider(statement.moduleReference.expression.text);
      assert.ok(!mapped, `${consumer} uses an unproved import-equals dependency on ${mapped?.provider}`);
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const dynamic = analysis.dynamicCalls.get(node);
      if (!dynamic) {
        ts.forEachChild(node, visit);
        return;
      }
      dynamicCallOrdinal += 1;
      if (dynamic.call === "import") assert.equal(dynamic.argumentCount, 1,
        `${consumer} uses an unproved multi-argument dynamic dependency`);
      if (!dynamic.argument || !ts.isStringLiteral(dynamic.argument)) {
        const normalized = dynamic.argument && normalizeExpression(dynamic.argument, source);
        const exception = computedExceptions.find((candidate) => candidate.path === consumer
          && candidate.call === dynamic.call
          && candidate.dynamic_call_ordinal === dynamicCallOrdinal
          && candidate.normalized_expression === normalized
          && candidate.normalized_expression_sha256 === expressionHash(normalized));
        assert.ok(exception && (dynamic.call === "import" || dynamic.directRequire),
          `${consumer} uses an unproved nonliteral dynamic dependency`);
        usedComputedExceptions.set(exception, (usedComputedExceptions.get(exception) ?? 0) + 1);
        ts.forEachChild(node, visit);
        return;
      }
      const mapped = mappedProvider(dynamic.argument.text);
      if (mapped) assert.equal(dynamic.argumentCount, 1,
        `${consumer} uses an unproved multi-argument dynamic dependency on ${mapped.provider}`);
      assert.ok(!mapped, `${consumer} uses an unproved dynamic dependency on ${mapped?.provider}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
};

export const assertFixturePlatformImports = <T extends ComputedDynamicDependencyException>(
  sourceText: string,
  consumer: string,
  candidates: ReadonlySet<string>,
  computedExceptions: readonly T[],
  usedComputedExceptions = new Map<T, number>(),
): string[] => {
  const source = ts.createSourceFile(consumer, sourceText, ts.ScriptTarget.Latest, true);
  const analysis = requireAnalysis(source);
  assertAllRequireReferencesAccounted(source, consumer, analysis);
  const publicSpecifiers = new Set([
    "simfile", "simfile/dynamics", "simfile/moltnet", "simfile/observe",
    "simfile/runtime", "simfile/schema", "simfile/spawnfile",
  ]);
  const allowedExternal = new Set(["@noopolis/stele", "yaml", "zod"]);
  const usedPublic = new Set<string>();
  let dynamicCallOrdinal = 0;
  const check = (specifier: string) => {
    if (specifier.startsWith(".")) {
      assert.ok(resolveImport(consumer, specifier, candidates),
        `${consumer} reaches outside the fixture platform through ${specifier}`);
    } else if (publicSpecifiers.has(specifier)) usedPublic.add(specifier);
    else if (specifier.startsWith("node:") || allowedExternal.has(specifier)) return;
    else assert.fail(`${consumer} imports non-public package ${specifier}`);
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) check(node.moduleSpecifier.text);
    else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
      check(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node)) {
      const dynamic = analysis.dynamicCalls.get(node);
      if (dynamic) {
        dynamicCallOrdinal += 1;
        if (dynamic.call === "import") assert.equal(dynamic.argumentCount, 1,
          `${consumer} uses an unproved multi-argument dynamic dependency`);
        if (dynamic.argument && ts.isStringLiteral(dynamic.argument)) {
          check(dynamic.argument.text);
        } else {
          const normalized = dynamic.argument && normalizeExpression(dynamic.argument, source);
          const exception = computedExceptions.find((candidate) => candidate.path === consumer
            && candidate.call === dynamic.call
            && candidate.dynamic_call_ordinal === dynamicCallOrdinal
            && candidate.normalized_expression === normalized
            && candidate.normalized_expression_sha256 === expressionHash(normalized));
          assert.ok(exception && (dynamic.call === "import" || dynamic.directRequire),
            `${consumer} uses an unproved nonliteral dynamic dependency`);
          usedComputedExceptions.set(exception, (usedComputedExceptions.get(exception) ?? 0) + 1);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...usedPublic] .sort();
};
