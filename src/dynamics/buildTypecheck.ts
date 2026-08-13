import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { DYNAMICS_BUILD_CONTRACT, DYNAMICS_BUILD_PREPARATION_POLICY } from "./buildInput.js";
import { compareUtf16 } from "./buildIdentity.js";
import type { StaticCompilerReadGuard } from "./buildStaticCompilerHostPolicy.js";

export interface DynamicsTypecheckResult {
  readonly inputPaths: readonly string[];
  readonly typeSurface?: Readonly<{ files: readonly string[]; root: string }>;
}

const {
  source: sourcePolicy,
  suppression: suppressionPolicy,
  simfileDynamics,
  typescript: typescriptPolicy,
  package: packagePolicy
} = DYNAMICS_BUILD_PREPARATION_POLICY;

const declarationExtensions = sourcePolicy.declarationExtensions as readonly string[];
const checkedExtensions = sourcePolicy.checkedExtensions as readonly string[];
const javaScriptSyntaxExtensions = sourcePolicy.javaScriptSyntaxExtensions as readonly string[];
const rejectRuntimeExtensions = sourcePolicy.rejectRuntimeTypeExtensions as readonly string[];
const transformExtensions = sourcePolicy.transformExtensions as readonly string[];
const fullLineSuppressions = suppressionPolicy.fullLineDirectives as readonly string[];
const acceptedErasedForms = new Set<string>(simfileDynamics.acceptedErasedForms);
const runtimeCallForms = new Set<string>(simfileDynamics.runtimeCallForms);
const runtimeExpressionUnwrap = new Set<string>(simfileDynamics.runtimeExpressionUnwrap);
const compileModuleKind = (() => {
  switch (typescriptPolicy.compilerOptions.module) {
    case "NodeNext": return ts.ModuleKind.NodeNext;
    default: throw new Error(`unsupported TypeScript module setting: ${typescriptPolicy.compilerOptions.module}`);
  }
})();
const compileModuleResolution = (() => {
  switch (typescriptPolicy.compilerOptions.moduleResolution) {
    case "NodeNext": return ts.ModuleResolutionKind.NodeNext;
    default: throw new Error(`unsupported TypeScript module resolution setting: ${typescriptPolicy.compilerOptions.moduleResolution}`);
  }
})();
const compileTarget = (() => {
  switch (typescriptPolicy.compilerOptions.target) {
    case "ES2022": return ts.ScriptTarget.ES2022;
    default: throw new Error(`unsupported TypeScript target setting: ${typescriptPolicy.compilerOptions.target}`);
  }
})();

const hasExtension = (fileName: string, extension: string): boolean => fileName.endsWith(extension);
const hasAnyExtension = (fileName: string, extensions: readonly string[]): boolean =>
  extensions.some((extension) => hasExtension(fileName, extension));

export const isTypeScriptFamily = (fileName: string): boolean => hasAnyExtension(fileName, checkedExtensions);
export const isDeclarationFile = (fileName: string): boolean => hasAnyExtension(fileName, declarationExtensions);
export const isTransformableTypeScriptSource = (fileName: string): boolean =>
  !isDeclarationFile(fileName) && hasAnyExtension(fileName, transformExtensions);
export const isRejectedRuntimeTypeScriptSource = (fileName: string): boolean =>
  hasAnyExtension(fileName, rejectRuntimeExtensions) && !isDeclarationFile(fileName);

const isJavaScriptSource = (fileName: string): boolean =>
  hasAnyExtension(fileName, javaScriptSyntaxExtensions);

const hostTypeRoot = (() => {
  switch (typescriptPolicy.typeRootResolution) {
    case "package-parent": {
      const manifest = createRequire(import.meta.url).resolve(
        `${typescriptPolicy.typeRootPackage}/${packagePolicy.manifestFileName}`
      );
      return path.dirname(path.dirname(manifest));
    }
    default:
      throw new Error(`unsupported TypeScript type-root resolution: ${typescriptPolicy.typeRootResolution}`);
  }
})();

/** Host-owned type roots are explicit preparation inputs, never project discovery. */
export const dynamicsConfiguredTypeRoots = (): readonly string[] => [hostTypeRoot];

const compilerOptions: ts.CompilerOptions = {
  allowJs: typescriptPolicy.allowJs,
  checkJs: typescriptPolicy.checkJs,
  allowImportingTsExtensions: typescriptPolicy.compilerOptions.allowImportingTsExtensions,
  module: compileModuleKind,
  moduleResolution: compileModuleResolution,
  noEmit: DYNAMICS_BUILD_CONTRACT.typescript.noEmit,
  strict: DYNAMICS_BUILD_CONTRACT.typescript.strict,
  target: compileTarget,
  typeRoots: [hostTypeRoot],
  types: [...typescriptPolicy.types]
};

export const dynamicsDefaultLibraryRoot = (): string => path.dirname(path.dirname(ts.getDefaultLibFilePath(compilerOptions)));

/** Resolves configured `types` through the same guarded host used by the compiler. */
export const dynamicsConfiguredTypeEntries = (host: ts.ModuleResolutionHost): readonly string[] => {
  const entries = typescriptPolicy.types.map((name) => {
    const containing = path.join(hostTypeRoot, "__simfile_configured_types__.ts");
    const resolved = ts.resolveTypeReferenceDirective(name, containing, compilerOptions, host).resolvedTypeReferenceDirective;
    if (!resolved?.resolvedFileName) throw new Error(`dynamics TypeScript check cannot resolve configured type: ${name}`);
    return path.resolve(resolved.resolvedFileName);
  });
  return [...new Set(entries)].sort(compareUtf16);
};

const isTypeScriptSyntaxFile = (fileName: string): boolean => isTypeScriptFamily(fileName) && !isJavaScriptSource(fileName);

const formatDiagnostics = (diagnostics: readonly ts.Diagnostic[]): string => ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCanonicalFileName: (name) => name, getCurrentDirectory: () => "", getNewLine: () => "\n"
}).replaceAll(/\x1b\[[0-9;]*m/g, "");

const isTypeOnlyImportClause = (clause: ts.ImportClause): boolean => {
  if (clause.isTypeOnly) return acceptedErasedForms.has("import-clause");
  if (clause.name !== undefined) return false;
  const bindings = clause.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings) || bindings.elements.length === 0) return false;
  return acceptedErasedForms.has("import-specifiers")
    && bindings.elements.every((specifier) => specifier.isTypeOnly);
};

const isTypeOnlyExport = (clause: ts.ExportDeclaration): boolean => {
  if (clause.isTypeOnly) return acceptedErasedForms.has("export-declaration");
  if (!clause.exportClause) return false;
  if (ts.isNamespaceExport(clause.exportClause)) return acceptedErasedForms.has("namespace-export");
  if (!ts.isNamedExports(clause.exportClause)) return false;
  return acceptedErasedForms.has("export-specifiers")
    && clause.exportClause.elements.length > 0
    && clause.exportClause.elements.every((item: ts.ExportSpecifier) => item.isTypeOnly);
};

const isDynamics = (value: unknown): boolean =>
  !!value && (ts.isStringLiteral(value as ts.Node) || ts.isNoSubstitutionTemplateLiteral(value as ts.Node))
    && (value as { text: string }).text === simfileDynamics.moduleSpecifier;

const isTypeOnlyImportType = (node: ts.Node): boolean =>
  acceptedErasedForms.has("import-type") && ts.isImportTypeNode(node) && isDynamics(node.argument);

const unwrap = (node: ts.Expression): ts.Expression => {
  if (runtimeExpressionUnwrap.has("parenthesized") && ts.isParenthesizedExpression(node)) return unwrap(node.expression);
  if (runtimeExpressionUnwrap.has("as-expression") && ts.isAsExpression(node)) return unwrap(node.expression);
  if (runtimeExpressionUnwrap.has("type-assertion") && ts.isTypeAssertionExpression(node)) return unwrap(node.expression);
  if (runtimeExpressionUnwrap.has("non-null") && ts.isNonNullExpression(node)) return unwrap(node.expression);
  if (runtimeExpressionUnwrap.has("comma-right")
    && ts.isBinaryExpression(node)
    && node.operatorToken.kind === ts.SyntaxKind.CommaToken) return unwrap(node.right);
  return node;
};

const requireCallee = (node: ts.Expression): "direct" | "call" | undefined => {
  const expression = unwrap(node);
  if (runtimeCallForms.has("require-direct")
    && ts.isIdentifier(expression)
    && expression.text === "require") return "direct";
  return runtimeCallForms.has("require-call")
    && ts.isPropertyAccessExpression(expression)
    && expression.name.text === "call"
    && requireCallee(expression.expression) === "direct"
    ? "call"
    : undefined;
};

const rejectRuntimeDynamicsSurface = (source: ts.SourceFile): void => {
  const reject = (): never => { throw new Error(simfileDynamics.runtimeResolutionFailure); };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && isDynamics(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (!clause || !isTypeOnlyImportClause(clause)) reject();
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && isDynamics(node.moduleSpecifier)) {
      if (!isTypeOnlyExport(node)) reject();
    } else if (isTypeOnlyImportType(node)) {
      return;
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && isDynamics(node.moduleReference.expression)) {
      if (!acceptedErasedForms.has("import-equals") || !node.isTypeOnly) reject();
    } else if (ts.isCallExpression(node)) {
      const callee = requireCallee(node.expression);
      const dynamicImport = runtimeCallForms.has("dynamic-import")
        && node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const argument = dynamicImport || callee === "direct"
        ? node.arguments[0]
        : callee === "call"
          ? node.arguments[1]
          : undefined;
      if (isDynamics(argument as ts.Expression | undefined)) reject();
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
};

/** Applies the simfile/dynamics syntax boundary to every parsed source kind. */
export const assertNoRuntimeDynamicsSurface = (fileName: string, text: string): void => {
  const kind = isTypeScriptSyntaxFile(fileName) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  rejectRuntimeDynamicsSurface(ts.createSourceFile(fileName, text, compileTarget, true, kind));
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const suppressPattern = new RegExp(
  `^\\s*//\\s*${escapeRegExp(suppressionPolicy.directivePrefix)}(?:${fullLineSuppressions.map(escapeRegExp).join("|")})\\b`,
  "u"
);
const rejectDiagnosticSuppressions = (source: ts.SourceFile): void => {
  if (!typescriptPolicy.rejectDiagnosticSuppressions) return;
  if (suppressionPolicy.placement !== "full-line"
    || !suppressionPolicy.commentKinds.includes("single-line")) {
    throw new Error("unsupported dynamics diagnostic-suppression policy");
  }
  const scanner = ts.createScanner(compileTarget, false, ts.LanguageVariant.Standard, source.text);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia) continue;
    const start = scanner.getTokenPos();
    const lineStart = source.text.lastIndexOf("\n", start - 1) + 1;
    if (source.text.slice(lineStart, start).trim() !== "" || !suppressPattern.test(scanner.getTokenText())) continue;
    throw new Error(`dynamics TypeScript check rejects diagnostic suppression in ${source.fileName}`);
  }
};

/** Checks the reachable TS family with host-owned NodeNext manifests and no tsconfig lookup. */
export const typecheckDynamicsModule = (
  entryPath: string,
  projectRoot: string,
  reachable: readonly string[],
  guard?: StaticCompilerReadGuard,
  declarationBackedJavaScriptRoots: ReadonlySet<string> = new Set()
): DynamicsTypecheckResult => {
  const sourcePaths = reachable.filter((fileName) =>
    isTypeScriptFamily(fileName)
    && !(isJavaScriptSource(fileName)
      && declarationBackedJavaScriptRoots.has(path.resolve(fileName)))
  ).map((fileName) => path.resolve(fileName)).sort(compareUtf16);
  if (sourcePaths.length === 0) return { inputPaths: [] };
  const surfacePath = dynamicsTypeSurfacePath();
  const surfaceRoot = path.dirname(surfacePath);
  const host = ts.createCompilerHost(compilerOptions, true);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const manifestFileName = packagePolicy.manifestFileName;
  const isProjectManifest = (fileName: string): boolean => path.basename(fileName) === manifestFileName
    && path.relative(projectRoot, fileName) !== ""
    && path.relative(projectRoot, fileName).split(path.sep)
      .every((part) => part !== ".." && part !== packagePolicy.nodeModulesDirectory);
  host.fileExists = (fileName) => isProjectManifest(path.resolve(fileName)) || (guard
    ? guard.checkedResolutionHost.fileExists?.(fileName) ?? false : fileExists(fileName));
  host.readFile = (fileName) => isProjectManifest(path.resolve(fileName))
    ? JSON.stringify({ type: typescriptPolicy.projectPackageType }) : (guard
      ? guard.checkedResolutionHost.readFile?.(fileName) : readFile(fileName));
  if (guard) {
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      guard.assertCheckedRead(fileName);
      return getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    };
  }
  const resolveModuleNames = (names: string[], containing: string): (ts.ResolvedModule | undefined)[] => names.map((name) => name === simfileDynamics.moduleSpecifier ? {
    extension: surfacePath.endsWith(".d.ts") ? ts.Extension.Dts : ts.Extension.Ts, isExternalLibraryImport: true, resolvedFileName: surfacePath
  } : ts.resolveModuleName(name, containing, compilerOptions, guard?.checkedResolutionHost ?? host).resolvedModule);
  guard?.freezePreflight();
  const program = ts.createProgram({ host: { ...host, getCurrentDirectory: () => projectRoot, resolveModuleNames }, options: compilerOptions, rootNames: sourcePaths.length ? sourcePaths : [entryPath] });
  for (const source of program.getSourceFiles()) {
    if (isTypeScriptFamily(source.fileName)) {
      assertNoRuntimeDynamicsSurface(source.fileName, source.text);
      rejectDiagnosticSuppressions(source);
    }
  }
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) throw new Error(`dynamics TypeScript check failed:\n${formatDiagnostics(diagnostics)}`);
  const defaultLib = path.dirname(ts.getDefaultLibFilePath(compilerOptions));
  const inputPaths = program.getSourceFiles().map((source) => path.resolve(source.fileName))
    .filter((fileName) => !fileName.startsWith(`${defaultLib}${path.sep}`)).sort(compareUtf16);
  const surfaceFiles = inputPaths.filter((fileName) => fileName === surfacePath || fileName.startsWith(`${surfaceRoot}${path.sep}`));
  return { inputPaths, ...(surfaceFiles.length ? { typeSurface: { files: surfaceFiles, root: surfaceRoot } } : {}) };
};

export const dynamicsTypeSurfacePath = (): string => {
  const source = fileURLToPath(new URL("./index.ts", import.meta.url));
  return existsSync(source) ? source : fileURLToPath(new URL("./index.d.ts", import.meta.url));
};
