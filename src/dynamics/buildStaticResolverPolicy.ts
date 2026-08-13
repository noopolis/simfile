import ts from "typescript";
import path from "node:path";
import { readFile } from "node:fs/promises";

import { DYNAMICS_BUILD_PREPARATION_POLICY } from "./buildInput.js";
import {
  enclosingPackageFor,
  isContained,
  nodeModulesPackageFor,
  type PackageIdentity
} from "./buildPackagePolicy.js";
import type { DynamicsBuildSourceSnapshot } from "./buildSourceSnapshot.js";
import {
  DYNAMICS_STATIC_CLOSURE_POLICY,
  assertStaticPathReference,
  validateStaticDirectoryPath,
  validateStaticSourcePath,
  type StaticClosurePolicy
} from "./buildStaticPolicy.js";

export interface StaticSourceSpecifier {
  readonly kind: "module" | "path-reference" | "type-reference";
  readonly mode: "runtime" | "type-only";
  readonly specifier: string;
}
export interface StaticRuntimeSourceBinding {
  readonly boundary: string;
  readonly fileName: string;
  readonly identity?: PackageIdentity;
  readonly kind: "package" | "project";
}

export interface StaticGraphAdapter<T extends { readonly fileName: string }> {
  readonly edge: (importer: T, target: T, specifier: StaticSourceSpecifier) => Promise<void> | void;
  readonly inspect: (source: T, text: string) => Promise<void> | void;
  readonly read: (fileName: string) => Promise<string>;
  readonly resolve: (specifier: StaticSourceSpecifier, importer: T) => Promise<string | undefined> | string | undefined;
  readonly validate: (fileName: string) => Promise<T>;
}

const staticTypeScriptPolicy = DYNAMICS_BUILD_PREPARATION_POLICY.typescript;

export const staticResolutionOptions: ts.CompilerOptions = {
  allowImportingTsExtensions: staticTypeScriptPolicy.compilerOptions.allowImportingTsExtensions,
  allowJs: staticTypeScriptPolicy.allowJs,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2022
};

/** Resolves executable package bytes without substituting declaration packages. */
export const staticRuntimeResolutionOptions: ts.CompilerOptions = {
  ...staticResolutionOptions,
  noDtsResolution: staticTypeScriptPolicy.runtimeNoDtsResolution
};

/** TypeScript may read approved package files, but must not erase their lexical path. */
export const staticResolutionHost: ts.ModuleResolutionHost = { ...ts.sys, realpath: undefined };

export const staticSharedPathAnchor = (left: string, right: string): string => {
  const leftParts = path.resolve(left).split(path.sep);
  const rightParts = path.resolve(right).split(path.sep);
  const parts: string[] = [];
  for (let index = 0; index < Math.min(leftParts.length, rightParts.length) && leftParts[index] === rightParts[index]; index += 1) {
    parts.push(leftParts[index] as string);
  }
  return parts.length > 1 ? path.resolve(path.parse(left).root, ...parts.slice(1)) : path.parse(left).root;
};

/** Resolves and validates one executable source against its lexical owner. */
export const validateStaticRuntimeSource = async (
  fileName: string,
  projectRoot: string,
  snapshot: DynamicsBuildSourceSnapshot
): Promise<StaticRuntimeSourceBinding> => {
  const candidate = path.resolve(fileName);
  await validateStaticSourcePath(
    candidate,
    staticSharedPathAnchor(projectRoot, candidate),
    DYNAMICS_STATIC_CLOSURE_POLICY
  );
  const localPackage = await nodeModulesPackageFor(candidate, snapshot.readBytes);
  const source = localPackage
    ? {
      boundary: localPackage.directory,
      fileName: candidate,
      identity: localPackage,
      kind: "package" as const
    }
    : isContained(projectRoot, candidate)
      ? { boundary: projectRoot, fileName: candidate, kind: "project" as const }
      : await (async () => {
        const identity = await enclosingPackageFor(candidate, snapshot.readBytes);
        if (!identity) {
          throw new Error(`reachable code has no owning package below ${projectRoot}: ${candidate}`);
        }
        return {
          boundary: identity.directory,
          fileName: candidate,
          identity,
          kind: "package" as const
        };
      })();
  const validated = await validateStaticSourcePath(
    candidate,
    source.boundary,
    DYNAMICS_STATIC_CLOSURE_POLICY
  );
  return { ...source, fileName: validated };
};

/** Checks every Node search candidate before TypeScript can read package metadata. */
export const validateStaticPackageSearchPaths = async (
  specifier: string,
  importerFileName: string,
  projectRoot: string,
  policy: StaticClosurePolicy = DYNAMICS_STATIC_CLOSURE_POLICY
): Promise<void> => {
  const segments = specifier.startsWith("@") ? specifier.split("/").slice(0, 2) : [specifier];
  for (let directory = path.dirname(path.resolve(importerFileName));;) {
    if (path.basename(directory) !== "node_modules") {
      const modules = path.join(directory, "node_modules");
      const shared = staticSharedPathAnchor(projectRoot, modules);
      const boundary = path.resolve(shared) === path.resolve(modules) ? path.dirname(shared) : shared;
      try {
        await validateStaticDirectoryPath(modules, boundary, policy);
        await validateStaticDirectoryPath(path.join(modules, ...segments), boundary, policy);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
};

/** Resolves a project-local package entry only after each package path is checked. */
export const checkedProjectPackageEntry = async (
  specifier: string,
  projectRoot: string,
  policy: StaticClosurePolicy = DYNAMICS_STATIC_CLOSURE_POLICY
): Promise<string | undefined> => {
  if (specifier.startsWith(".") || specifier.startsWith("node:")) return undefined;
  const segments = specifier.startsWith("@") ? specifier.split("/").slice(0, 2) : [specifier];
  const modules = path.join(projectRoot, "node_modules");
  const directory = path.join(modules, ...segments);
  try {
    await validateStaticDirectoryPath(modules, projectRoot, policy);
    await validateStaticDirectoryPath(directory, projectRoot, policy);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const manifest = path.join(directory, "package.json");
  const fileName = await validateStaticSourcePath(manifest, directory, policy);
  const parsed = JSON.parse(new TextDecoder().decode(await readFile(fileName))) as { main?: unknown; module?: unknown };
  const entry = typeof parsed.module === "string" ? parsed.module : parsed.main;
  return typeof entry === "string" && entry.startsWith("./") ? path.join(directory, entry) : undefined;
};

export const policyHas = (values: readonly string[], value: string): boolean => values.includes(value);

export const unwrapStaticExpression = (expression: ts.Expression, policy: StaticClosurePolicy, compiler: typeof ts = ts): ts.Expression => {
  let current = expression;
  while (true) {
    if (compiler.isParenthesizedExpression(current) && policyHas(policy.source.expressionUnwrap, "parenthesized")) current = current.expression;
    else if (compiler.isAsExpression(current) && policyHas(policy.source.expressionUnwrap, "as-expression")) current = current.expression;
    else if (compiler.isTypeAssertionExpression(current) && policyHas(policy.source.expressionUnwrap, "type-assertion")) current = current.expression;
    else if (compiler.isNonNullExpression(current) && policyHas(policy.source.expressionUnwrap, "non-null")) current = current.expression;
    else return current;
  }
};

export const unwrapStaticCallExpression = (expression: ts.Expression, policy: StaticClosurePolicy): ts.Expression => {
  let current = expression;
  while (true) {
    const unwrapped = unwrapStaticExpression(current, policy);
    if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.CommaToken) current = unwrapped.right;
    else return unwrapped;
  }
};

const literalValue = (expression: ts.Expression, policy: StaticClosurePolicy): string | undefined => {
  const unwrapped = unwrapStaticExpression(expression, policy);
  if (ts.isStringLiteral(unwrapped) && policyHas(policy.source.literalSpecifierKinds, "string-literal")) return unwrapped.text;
  if (ts.isNoSubstitutionTemplateLiteral(unwrapped) && policyHas(policy.source.literalSpecifierKinds, "no-substitution-template")) return unwrapped.text;
  if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literalValue(unwrapped.left, policy);
    const right = literalValue(unwrapped.right, policy);
    if (left !== undefined && right !== undefined) return `${left}${right}`;
  }
  return undefined;
};

export const staticLiteralSpecifierValue = (expression: ts.Expression, policy: StaticClosurePolicy, compiler: typeof ts = ts): string | undefined => {
  const unwrapped = unwrapStaticExpression(expression, policy, compiler);
  if (compiler.isStringLiteral(unwrapped) && policyHas(policy.source.literalSpecifierKinds, "string-literal")) return unwrapped.text;
  if (compiler.isNoSubstitutionTemplateLiteral(unwrapped) && policyHas(policy.source.literalSpecifierKinds, "no-substitution-template")) return unwrapped.text;
  return undefined;
};

export const assertStaticSourceFileName = (fileName: string, policy: StaticClosurePolicy, compiler: typeof ts = ts): ts.ScriptKind => {
  const isTypeScript = policy.source.typeScriptExtensions.some((extension) => fileName.endsWith(extension));
  const isJavaScript = policy.source.javaScriptExtensions.some((extension) => fileName.endsWith(extension));
  const scriptKind = isTypeScript && policyHas(policy.source.scriptKinds, "ts") ? compiler.ScriptKind.TS
    : isJavaScript && policyHas(policy.source.scriptKinds, "js") ? compiler.ScriptKind.JS : undefined;
  if (scriptKind === undefined) throw new Error(`static source has an unsupported extension: ${fileName}`);
  if (policy.source.scriptTarget !== "ES2022") throw new Error("static source has an unsupported script target");
  return scriptKind;
};

export const staticSourceFile = (fileName: string, text: string, policy: StaticClosurePolicy, compiler: typeof ts = ts): ts.SourceFile => {
  const scriptKind = assertStaticSourceFileName(fileName, policy, compiler);
  const parsed = compiler.createSourceFile(fileName, text, compiler.ScriptTarget.ES2022, true, scriptKind);
  const diagnostics = (parsed as unknown as Readonly<{ parseDiagnostics: readonly ts.Diagnostic[] }>).parseDiagnostics;
  if (diagnostics.length > 0) throw new Error(`static source does not parse: ${fileName}`);
  return parsed;
};

/** Lists every literal compiler-observed module and type-reference edge without evaluation. */
export const staticSourceSpecifiers = (
  fileName: string,
  text: string,
  policy: StaticClosurePolicy,
  compiler: typeof ts = ts,
): readonly StaticSourceSpecifier[] => {
  const parsed = staticSourceFile(fileName, text, policy, compiler);
  const found: StaticSourceSpecifier[] = [];
  const add = (expression: ts.Expression | undefined, kind: StaticSourceSpecifier["kind"], mode: StaticSourceSpecifier["mode"]): void => {
    const specifier = expression && staticLiteralSpecifierValue(expression, policy, compiler);
    if (specifier !== undefined) found.push({ kind, mode, specifier });
  };
  const typeOnlyImport = (node: ts.ImportDeclaration): boolean => !!node.importClause && (node.importClause.isTypeOnly
    || (node.importClause.name === undefined && !!node.importClause.namedBindings && compiler.isNamedImports(node.importClause.namedBindings)
      && node.importClause.namedBindings.elements.length > 0 && node.importClause.namedBindings.elements.every((item) => item.isTypeOnly)));
  const typeOnlyExport = (node: ts.ExportDeclaration): boolean => node.isTypeOnly || (!!node.exportClause && compiler.isNamedExports(node.exportClause)
    && node.exportClause.elements.length > 0 && node.exportClause.elements.every((item) => item.isTypeOnly));
  const visit = (node: ts.Node): void => {
    if (compiler.isImportDeclaration(node)) add(node.moduleSpecifier, "module", typeOnlyImport(node) ? "type-only" : "runtime");
    else if (compiler.isExportDeclaration(node) && node.moduleSpecifier) add(node.moduleSpecifier, "module", typeOnlyExport(node) ? "type-only" : "runtime");
    else if (compiler.isImportEqualsDeclaration(node) && compiler.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression, "module", node.isTypeOnly ? "type-only" : "runtime");
    else if (compiler.isImportTypeNode(node) && compiler.isLiteralTypeNode(node.argument)) add(node.argument.literal, "module", "type-only");
    else if (compiler.isCallExpression(node) && node.expression.kind === compiler.SyntaxKind.ImportKeyword) add(node.arguments[0], "module", "runtime");
    else if (compiler.isCallExpression(node) && compiler.isIdentifier(node.expression) && node.expression.text === policy.source.requireIdentifier) add(node.arguments[0], "module", "runtime");
    compiler.forEachChild(node, visit);
  };
  visit(parsed);
  for (const reference of parsed.typeReferenceDirectives) found.push({ kind: "type-reference", mode: "type-only", specifier: reference.fileName });
  for (const reference of parsed.referencedFiles) found.push({ kind: "path-reference", mode: "type-only", specifier: reference.fileName });
  return found;
};

/** Resolves and reads a finite syntax graph only after each target path passes the supplied gate. */
export const preflightStaticGraph = async <T extends { readonly fileName: string }>(
  entries: readonly string[],
  policy: StaticClosurePolicy,
  adapter: StaticGraphAdapter<T>
): Promise<readonly T[]> => {
  const queued = [...entries];
  const checked = new Map<string, T>();
  for (let index = 0; index < queued.length; index += 1) {
    const source = await adapter.validate(queued[index] as string);
    if (checked.has(source.fileName)) continue;
    checked.set(source.fileName, source);
    assertStaticSourceFileName(source.fileName, policy);
    const text = await adapter.read(source.fileName);
    await adapter.inspect(source, text);
    for (const specifier of staticSourceSpecifiers(source.fileName, text, policy)) {
      if (specifier.kind === "path-reference") assertStaticPathReference(specifier.specifier, policy);
      const fileName = await adapter.resolve(specifier, source);
      if (fileName === undefined) continue;
      const target = await adapter.validate(fileName);
      await adapter.edge(source, target, specifier);
      if (!checked.has(target.fileName)) queued.push(target.fileName);
    }
  }
  return [...checked.values()];
};

export const isStaticResolverIdentifier = (expression: ts.Expression, policy: StaticClosurePolicy): boolean => {
  const unwrapped = unwrapStaticExpression(expression, policy);
  return ts.isIdentifier(unwrapped) && policyHas(policy.emitted.resolverIdentifiers, unwrapped.text);
};

export const staticMemberName = (node: ts.PropertyAccessExpression | ts.ElementAccessExpression, policy: StaticClosurePolicy): string | undefined => {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return node.argumentExpression === undefined ? undefined : literalValue(node.argumentExpression, policy);
};

export const isStaticResolverProperty = (node: ts.PropertyAccessExpression | ts.ElementAccessExpression, policy: StaticClosurePolicy): boolean => {
  const member = staticMemberName(node, policy);
  return member === policy.source.requireIdentifier || policyHas(policy.emitted.resolverIdentifiers, member ?? "");
};

export const staticWrappedExpressionCarrier = (node: ts.Node): ts.Node => {
  let carrier: ts.Node = node;
  while (carrier.parent) {
    if (ts.isParenthesizedExpression(carrier.parent) || ts.isAsExpression(carrier.parent)
      || ts.isTypeAssertionExpression(carrier.parent) || ts.isNonNullExpression(carrier.parent)) carrier = carrier.parent;
    else if (ts.isBinaryExpression(carrier.parent) && carrier.parent.operatorToken.kind === ts.SyntaxKind.CommaToken
      && carrier.parent.right === carrier) carrier = carrier.parent;
    else break;
  }
  return carrier;
};

export const collectStaticResolverAliases = (node: ts.Node, policy: StaticClosurePolicy, aliases: Set<string>): void => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined
    && isStaticResolverIdentifier(node.initializer, policy)) aliases.add(node.name.text);
  ts.forEachChild(node, (child) => collectStaticResolverAliases(child, policy, aliases));
};

export const isStaticCallOnResolver = (expression: ts.Expression, policy: StaticClosurePolicy, aliases: ReadonlySet<string>): boolean => {
  const callee = unwrapStaticCallExpression(expression, policy);
  if (ts.isIdentifier(callee) && aliases.has(callee.text)) return true;
  if (isStaticResolverIdentifier(callee, policy)) return true;
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return false;
  const property = staticMemberName(callee, policy);
  if (property !== undefined && policyHas(policy.emitted.resolverIdentifiers, property)) return true;
  return (property === "call" || property === "apply")
    && (isStaticResolverIdentifier(callee.expression, policy) || (ts.isIdentifier(callee.expression) && aliases.has(callee.expression.text)));
};
