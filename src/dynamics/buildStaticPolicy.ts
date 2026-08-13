import { lstat } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript";

import { compareUtf16, deepFreeze } from "./buildIdentity.js";
import { DYNAMICS_BUILD_PREPARATION_POLICY } from "./buildInput.js";
import {
  collectPinnedCommonJsInitializerIdentifiers,
  isCommonJsCandidateIdentifier,
  isCommonJsInitializerArgument,
  isExactCommonJsInitializerCall
} from "./buildStaticCommonJsPolicy.js";
import {
  collectStaticResolverAliases,
  isStaticCallOnResolver,
  isStaticResolverIdentifier,
  isStaticResolverProperty,
  staticLiteralSpecifierValue,
  staticMemberName,
  staticSourceFile,
  staticWrappedExpressionCarrier,
  unwrapStaticCallExpression,
  unwrapStaticExpression
} from "./buildStaticResolverPolicy.js";

export interface StaticMetafileImport {
  readonly external?: boolean;
  readonly path: string;
}

export type StaticModuleSpecifierKind = "node-builtin" | "package" | "relative";

export interface StaticClosurePolicy {
  readonly build: Readonly<{
    preserveSymlinks: true;
  }>;
  readonly emitted: Readonly<{
    commonJsInitializerIdentifiers: readonly string[];
    commonJsReservedIdentifierPattern: string;
    dynamicImport: "reject";
    dynamicRequireIdentifierPrefixes: readonly string[];
    resolverIdentifiers: readonly string[];
  }>;
  readonly metafile: Readonly<{
    externalFlag: boolean;
    ordering: "utf16";
  }>;
  readonly path: Readonly<{
    boundary: "regular-non-symlink-directory";
    leaf: "regular-non-symlink-file";
    lexicalContainment: "contained";
    traversedDirectories: "regular-non-symlink-directory";
  }>;
  readonly source: Readonly<{
    expressionUnwrap: readonly string[];
    javaScriptExtensions: readonly string[];
    literalSpecifierKinds: readonly string[];
    lookupForms: readonly string[];
    requireIdentifier: string;
    scriptKinds: readonly string[];
    scriptTarget: "ES2022";
    typeScriptExtensions: readonly string[];
  }>;
  readonly specifier: Readonly<{
    absolutePrefixes: readonly string[];
    approvedNodeBuiltins: readonly string[];
    bareBuiltinNames: readonly string[];
    nodeBuiltinPrefix: "node:";
    relativePrefixes: readonly string[];
    urlSchemePattern: string;
    windowsDriveAbsolutePattern: string;
  }>;
}

const has = (values: readonly string[], value: string): boolean => values.includes(value);

const LEGACY_BARE_NODE_BUILTINS = builtinModules.filter((name) => !name.startsWith("node:"));
const SIMFILE_DYNAMICS_MODULE_SPECIFIER = DYNAMICS_BUILD_PREPARATION_POLICY.simfileDynamics.moduleSpecifier;
const isSimfileDynamicsSpecifier = (specifier: string): boolean =>
  specifier === SIMFILE_DYNAMICS_MODULE_SPECIFIER;

export const DYNAMICS_STATIC_CLOSURE_POLICY: Readonly<StaticClosurePolicy> = deepFreeze({
  build: {
    preserveSymlinks: true,
  },
  emitted: {
    commonJsInitializerIdentifiers: ["__commonJS"],
    commonJsReservedIdentifierPattern: "__commonJS",
    dynamicImport: "reject",
    dynamicRequireIdentifierPrefixes: ["__require"],
    resolverIdentifiers: ["require", "createRequire"],
  },
  metafile: {
    externalFlag: true,
    ordering: "utf16",
  },
  path: {
    boundary: "regular-non-symlink-directory",
    leaf: "regular-non-symlink-file",
    lexicalContainment: "contained",
    traversedDirectories: "regular-non-symlink-directory",
  },
  source: {
    expressionUnwrap: ["parenthesized", "as-expression", "type-assertion", "non-null"],
    javaScriptExtensions: [".js", ".mjs", ".cjs"],
    literalSpecifierKinds: ["string-literal", "no-substitution-template"],
    lookupForms: ["static-import", "static-export", "dynamic-import", "require-direct"],
    requireIdentifier: "require",
    scriptKinds: ["js", "ts"],
    scriptTarget: "ES2022",
    typeScriptExtensions: [".ts", ".tsx", ".mts", ".cts"],
  },
  specifier: {
    absolutePrefixes: ["/", "\\"],
    approvedNodeBuiltins: [...DYNAMICS_BUILD_PREPARATION_POLICY.nodeBuiltins],
    bareBuiltinNames: LEGACY_BARE_NODE_BUILTINS,
    nodeBuiltinPrefix: "node:",
    relativePrefixes: ["./", "../"],
    urlSchemePattern: "^(?![A-Za-z]:[\\\\/])[A-Za-z][A-Za-z0-9+.-]*:",
    windowsDriveAbsolutePattern: "^[A-Za-z]:[\\\\/]",
  },
});

export const staticPreserveSymlinks = (
  policy: StaticClosurePolicy = DYNAMICS_STATIC_CLOSURE_POLICY
): true => {
  if (policy.build.preserveSymlinks !== true) throw new Error("static source has an unsupported symlink preservation policy");
  return true;
};

const assertRegularDirectory = async (candidate: string, rule: string): Promise<void> => {
  if (rule !== "regular-non-symlink-directory") throw new Error("static source has an unsupported directory path policy");
  const stat = await lstat(candidate);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`static source path is not regular: ${candidate}`);
};

export const validateStaticSourcePath = async (
  candidate: string,
  boundary: string,
  policy: StaticClosurePolicy = DYNAMICS_STATIC_CLOSURE_POLICY
): Promise<string> => {
  if (policy.path.lexicalContainment !== "contained") throw new Error("static source has an unsupported containment path policy");
  const root = path.resolve(boundary);
  const fileName = path.resolve(candidate);
  const relative = path.relative(root, fileName);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`static source path is outside its boundary: ${candidate}`);
  }
  await assertRegularDirectory(root, policy.path.boundary);
  const parts = relative.split(path.sep);
  for (let index = 0; index < parts.length - 1; index += 1) {
    await assertRegularDirectory(path.join(root, ...parts.slice(0, index + 1)), policy.path.traversedDirectories);
  }
  if (policy.path.leaf !== "regular-non-symlink-file") throw new Error("static source has an unsupported leaf path policy");
  const leaf = await lstat(fileName);
  if (leaf.isSymbolicLink() || !leaf.isFile()) throw new Error(`static source path leaf is not a regular file: ${candidate}`);
  return fileName;
};

/** Validates a trusted-anchor-contained directory before package resolution reads it. */
export const validateStaticDirectoryPath = async (
  candidate: string,
  boundary: string,
  policy: StaticClosurePolicy = DYNAMICS_STATIC_CLOSURE_POLICY
): Promise<string> => {
  const root = path.resolve(boundary);
  const directory = path.resolve(candidate);
  const relative = path.relative(root, directory);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`static source directory is outside its boundary: ${candidate}`);
  }
  await assertRegularDirectory(root, policy.path.boundary);
  const parts = relative.split(path.sep);
  for (let index = 0; index < parts.length; index += 1) {
    await assertRegularDirectory(path.join(root, ...parts.slice(0, index + 1)), policy.path.traversedDirectories);
  }
  return directory;
};

export const classifyStaticModuleSpecifier = (
  specifier: string,
  policy: StaticClosurePolicy = DYNAMICS_STATIC_CLOSURE_POLICY
): StaticModuleSpecifierKind => {
  const rules = policy.specifier;
  if (specifier.startsWith(rules.nodeBuiltinPrefix)) {
    if (!rules.approvedNodeBuiltins.includes(specifier)) throw new Error(`static source uses an unapproved node builtin: ${specifier}`);
    return "node-builtin";
  }
  if (rules.absolutePrefixes.some((prefix) => specifier.startsWith(prefix)) || new RegExp(rules.windowsDriveAbsolutePattern, "u").test(specifier)) {
    throw new Error(`static source uses an absolute module specifier: ${specifier}`);
  }
  if (new RegExp(rules.urlSchemePattern, "u").test(specifier)) throw new Error(`static source uses a URL module specifier: ${specifier}`);
  if (rules.bareBuiltinNames.includes(specifier)) throw new Error(`static source uses a legacy node builtin spelling: ${specifier}`);
  return rules.relativePrefixes.some((prefix) => specifier.startsWith(prefix)) ? "relative" : "package";
};

/** Path references are filesystem paths, so bare names remain importer-relative. */
export const assertStaticPathReference = (
  specifier: string,
  policy: StaticClosurePolicy = DYNAMICS_STATIC_CLOSURE_POLICY
): void => {
  const rules = policy.specifier;
  if (specifier.length === 0 || specifier.includes("\0")
    || rules.absolutePrefixes.some((prefix) => specifier.startsWith(prefix))
    || new RegExp(rules.windowsDriveAbsolutePattern, "u").test(specifier)
    || new RegExp(rules.urlSchemePattern, "u").test(specifier)) {
    throw new Error(`static source has an unsafe path reference: ${specifier}`);
  }
};

const assertLiteral = (expression: ts.Expression, policy: StaticClosurePolicy): void => {
  const specifier = staticLiteralSpecifierValue(expression, policy);
  if (specifier === undefined) throw new Error("static source has a nonliteral module lookup");
  classifyStaticModuleSpecifier(specifier, policy);
};

const isDirectResolverCallOnSimfileModule = (
  node: ts.CallExpression,
  policy: StaticClosurePolicy,
  aliases: ReadonlySet<string>
): boolean => {
  const callee = unwrapStaticCallExpression(node.expression, policy);
  if (ts.isIdentifier(callee) && (isStaticResolverIdentifier(callee, policy) || aliases.has(callee.text))) {
    if (node.arguments.length === 0) return false;
    const specifier = staticLiteralSpecifierValue(node.arguments[0], policy);
    return specifier !== undefined && isSimfileDynamicsSpecifier(specifier);
  }
  if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
    const calledProperty = staticMemberName(callee, policy);
    if (calledProperty !== "call") return false;
    if (node.arguments.length < 2) return false;
    const calledReceiver = unwrapStaticExpression(callee.expression, policy);
    if (ts.isIdentifier(calledReceiver) && (isStaticResolverIdentifier(calledReceiver, policy) || aliases.has(calledReceiver.text))) {
      const specifier = staticLiteralSpecifierValue(node.arguments[1], policy);
      return specifier !== undefined && isSimfileDynamicsSpecifier(specifier);
    }
  }
  return false;
};

export const assertStaticSource = (
  fileName: string,
  text: string,
  policy: StaticClosurePolicy = DYNAMICS_STATIC_CLOSURE_POLICY
): void => {
  const parsed = staticSourceFile(fileName, text, policy);
  const resolverAliases = new Set<string>();
  collectStaticResolverAliases(parsed, policy, resolverAliases);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (!has(policy.source.lookupForms, "static-import")) throw new Error("static source has an unsupported import declaration");
      assertLiteral(node.moduleSpecifier, policy);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (!has(policy.source.lookupForms, "static-export")) throw new Error("static source has an unsupported export declaration");
      assertLiteral(node.moduleSpecifier, policy);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      if (!has(policy.source.lookupForms, "static-import") || !node.moduleReference.expression) {
        throw new Error("static source has an unsupported import-equals declaration");
      }
      assertLiteral(node.moduleReference.expression, policy);
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (!has(policy.source.lookupForms, "dynamic-import") || node.arguments.length !== 1) {
          throw new Error("static source has an invalid import lookup");
        }
        const specifier = staticLiteralSpecifierValue(node.arguments[0], policy);
        if (specifier === undefined) throw new Error("static source has a nonliteral dynamic module lookup");
        if (isSimfileDynamicsSpecifier(specifier)) return;
        if (classifyStaticModuleSpecifier(specifier, policy) !== "relative") {
          throw new Error("static source has a non-relative dynamic module lookup");
        }
      } else if (!node.questionDotToken && isStaticResolverIdentifier(node.expression, policy) && has(policy.source.lookupForms, "require-direct")) {
        if (node.arguments.length !== 1) throw new Error("static source has an invalid require lookup");
        if (!isDirectResolverCallOnSimfileModule(node, policy, resolverAliases)) {
          assertLiteral(node.arguments[0], policy);
        }
      } else if (isStaticCallOnResolver(node.expression, policy, resolverAliases)) {
        if (isDirectResolverCallOnSimfileModule(node, policy, resolverAliases)) return;
        throw new Error("static source lets require escape through a property lookup");
      }
    }
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && isStaticResolverProperty(node, policy)) {
      throw new Error("static source lets require escape through a property lookup");
    }
    if (ts.isIdentifier(node) && isStaticResolverIdentifier(node, policy) && !resolverAliases.has(node.text)) {
      const carrier = staticWrappedExpressionCarrier(node);
      if (ts.isCallExpression(carrier.parent) && carrier.parent.expression === carrier) return;
      if ((ts.isPropertyAccessExpression(carrier.parent) || ts.isElementAccessExpression(carrier.parent))
        && ts.isCallExpression(carrier.parent.parent)
        && carrier.parent.parent.expression === carrier.parent
        && carrier.parent.parent.arguments.length >= 2
        && staticMemberName(carrier.parent, policy) === "call") {
        const argument = carrier.parent.parent.arguments[1];
        if (typeof argument !== "undefined" && staticLiteralSpecifierValue(argument, policy) === SIMFILE_DYNAMICS_MODULE_SPECIFIER) return;
      }
      throw new Error("static source lets require escape direct literal lookup");
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
};

export const assertStaticOwnershipEdge = (
  importerBoundary: string,
  targetBoundary: string,
  kind: StaticModuleSpecifierKind,
  original: string
): void => {
  if (kind === "relative" && importerBoundary !== targetBoundary) {
    throw new Error(`dynamics build lets a relative import escape its boundary: ${original}`);
  }
};

export const auditStaticMetafileImports = (
  imports: readonly StaticMetafileImport[],
  policy: StaticClosurePolicy = DYNAMICS_STATIC_CLOSURE_POLICY
): readonly string[] => {
  if (policy.metafile.ordering !== "utf16") throw new Error("static output has an unsupported metafile ordering");
  const used = new Set<string>();
  for (const item of imports) {
    if (item.external !== policy.metafile.externalFlag) continue;
    const kind = classifyStaticModuleSpecifier(item.path, policy);
    if (kind !== "node-builtin") throw new Error(`static output leaves an unapproved external: ${item.path}`);
    used.add(item.path);
  }
  return [...used].sort(compareUtf16);
};

const assertEmittedPolicy = (policy: StaticClosurePolicy): void => {
  if (policy.emitted.dynamicImport !== "reject") throw new Error("emitted ESM has an unsupported dynamic import policy");
  if (policy.emitted.commonJsInitializerIdentifiers.some((identifier) => identifier.length === 0)
    || policy.emitted.commonJsReservedIdentifierPattern.length === 0) throw new Error("emitted ESM has an unsupported CommonJS policy");
};

export const assertStaticEmittedEsm = (
  fileName: string,
  text: string,
  policy: StaticClosurePolicy = DYNAMICS_STATIC_CLOSURE_POLICY
): void => {
  assertEmittedPolicy(policy);
  const parsed = staticSourceFile(fileName, text, policy);
  const resolverAliases = new Set<string>();
  const pinnedCommonJs = collectPinnedCommonJsInitializerIdentifiers(parsed, policy);
  collectStaticResolverAliases(parsed, policy, resolverAliases);
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (!ts.isStringLiteralLike(node.moduleSpecifier)) throw new Error("emitted ESM has a nonliteral import");
      if (classifyStaticModuleSpecifier(node.moduleSpecifier.text, policy) !== "node-builtin") {
        throw new Error(`emitted ESM leaves a residual module lookup: ${node.moduleSpecifier.text}`);
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (policy.emitted.dynamicImport === "reject") throw new Error("emitted ESM has a dynamic import");
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && isCommonJsInitializerArgument(node.arguments[0])) {
      if (!isExactCommonJsInitializerCall(node, policy, pinnedCommonJs.declarations)) {
        throw new Error("emitted ESM has an unrecognized CommonJS initializer");
      }
    } else if (ts.isCallExpression(node) && isStaticCallOnResolver(node.expression, policy, resolverAliases)) {
      throw new Error("emitted ESM retains a host resolver");
    }
    if (ts.isIdentifier(node)) {
      const inPinnedCommonJsDeclaration = pinnedCommonJs.declarations.has(node);
      if (node.text === "__getOwnPropNames" && !pinnedCommonJs.getOwnPropNames.has(node)) {
        throw new Error("emitted ESM has an unrecognized CommonJS helper binding");
      }
      if (isStaticResolverIdentifier(node, policy)) throw new Error(`emitted ESM retains a host resolver: ${node.text}`);
      if (isCommonJsCandidateIdentifier(node.text, policy) && !inPinnedCommonJsDeclaration && !(
        ts.isCallExpression(node.parent)
        && node.parent.expression === node
        && isExactCommonJsInitializerCall(node.parent, policy, pinnedCommonJs.declarations)
      )) {
        throw new Error(`emitted ESM has an unrecognized CommonJS initializer: ${node.text}`);
      }
      if (policy.emitted.dynamicRequireIdentifierPrefixes.some((prefix) => node.text.startsWith(prefix)) && !pinnedCommonJs.requireDefinitions.has(node)) {
        throw new Error(`emitted ESM retains a host resolver: ${node.text}`);
      }
    }
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && isStaticResolverProperty(node, policy)) {
      throw new Error("emitted ESM retains a host resolver property");
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
};
