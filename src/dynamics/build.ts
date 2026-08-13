import path from "node:path";
import { build, version as esbuildVersion } from "esbuild";
import ts from "typescript";

import { DYNAMICS_BUILD_CONTRACT, DYNAMICS_BUILD_PREPARATION_POLICY } from "./buildInput.js";
import { compareUtf16, createDynamicsClosureIdentity, deepFreeze, sha256,
  type DynamicsBuildInputDescriptor } from "./buildIdentity.js";
import {
  assertNoRuntimeDynamicsSurface,
  isDeclarationFile,
  isRejectedRuntimeTypeScriptSource,
  isTypeScriptFamily,
  isTransformableTypeScriptSource,
  dynamicsDefaultLibraryRoot,
  dynamicsConfiguredTypeEntries,
  dynamicsConfiguredTypeRoots,
  dynamicsTypeSurfacePath,
  typecheckDynamicsModule
} from "./buildTypecheck.js";
import { createStaticCompilerReadGuard, type StaticCompilerReadGuard } from "./buildStaticCompilerHostPolicy.js";
import {
  assertStaticEmittedEsm,
  assertStaticOwnershipEdge,
  assertStaticPathReference,
  assertStaticSource,
  auditStaticMetafileImports,
  classifyStaticModuleSpecifier,
  DYNAMICS_STATIC_CLOSURE_POLICY,
  staticPreserveSymlinks,
  type StaticMetafileImport
} from "./buildStaticPolicy.js";
import {
  assertStaticSourceFileName,
  checkedProjectPackageEntry,
  preflightStaticGraph,
  staticResolutionOptions,
  staticRuntimeResolutionOptions,
  validateStaticRuntimeSource as validateRuntimeSource,
  validateStaticPackageSearchPaths,
  type StaticRuntimeSourceBinding as RuntimeSourceBinding,
  type StaticSourceSpecifier
} from "./buildStaticResolverPolicy.js";
import { assertExactRuntimeInputs, descriptorForStaticSource, preflightStaticRuntimeGraph, sortStaticInputs, staticTypeSurfaceDescriptor } from "./buildStaticGraphPolicy.js";
import { declarationBackedRuntimeRoots, enclosingPackageFor,
  type PackageIdentity } from "./buildPackagePolicy.js";
import { createDynamicsBuildSourceSnapshot,
  type DynamicsBuildSourceSnapshot } from "./buildSourceSnapshot.js";
import { resolveDynamicsModule } from "./modulePath.js";
type InputMode = "runtime" | "type-only";
interface StaticImportRecord extends StaticMetafileImport {
  readonly original?: string;
}
type StaticResolutionPurpose = "runtime" | "typecheck";
export interface PreparedDynamicsBuild {
  /** Deferred P2: readonly number[] has excessive cost; Uint8Array is a later public-surface change. */
  readonly artifactBytes: readonly number[];
  readonly artifactSha256: string;
  readonly closureDescriptor: Readonly<Record<string, unknown>>;
  readonly closureSha256: string;
  readonly inputs: readonly DynamicsBuildInputDescriptor[];
  readonly module: string;
  readonly nodeExternals: readonly string[];
  readonly typecheckMode: "none" | "typescript";
}
const {
  esbuild: esbuildPolicy,
  source: sourcePolicy,
  simfileDynamics,
  typescript: typescriptPolicy
} = DYNAMICS_BUILD_PREPARATION_POLICY;
const closurePreparationPolicy = deepFreeze({
  ...DYNAMICS_BUILD_PREPARATION_POLICY,
  staticClosure: DYNAMICS_STATIC_CLOSURE_POLICY
});
const ambiguousJavaScriptExtension = sourcePolicy.ambiguousJavaScriptExtension;
const simfileSpecifierPattern = new RegExp(`^${simfileDynamics.moduleSpecifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
const transpileModuleCompilerOptions = (() => {
  const module = esbuildPolicy.onLoadTranspile.module === "ESNext" ? ts.ModuleKind.ESNext : (() => {
    throw new Error(`unsupported prepare transform module setting: ${esbuildPolicy.onLoadTranspile.module}`);
  })();
  const target = esbuildPolicy.onLoadTranspile.target === "ES2022" ? ts.ScriptTarget.ES2022 : (() => {
    throw new Error(`unsupported prepare transform target setting: ${esbuildPolicy.onLoadTranspile.target}`);
  })();
  return { module, target } as const;
})();
const resolveStaticGraphSpecifier = async (
  specifier: StaticSourceSpecifier,
  importer: RuntimeSourceBinding,
  projectRoot: string,
  readGuard: StaticCompilerReadGuard,
  purpose: StaticResolutionPurpose
): Promise<string | undefined> => {
  if (specifier.specifier === simfileDynamics.moduleSpecifier) return importer.fileName;
  if (specifier.kind === "module" && specifier.specifier.startsWith("node:")) return undefined;
  if (specifier.kind === "path-reference") {
    assertStaticPathReference(specifier.specifier, DYNAMICS_STATIC_CLOSURE_POLICY);
    return path.resolve(path.dirname(importer.fileName), specifier.specifier);
  }
  const typeOnlyLegacyBuiltin = (specifier.mode === "type-only" || isDeclarationFile(importer.fileName)) && !specifier.specifier.startsWith("node:")
    && DYNAMICS_STATIC_CLOSURE_POLICY.specifier.bareBuiltinNames.includes(specifier.specifier);
  if (typeOnlyLegacyBuiltin) return undefined;
  const kind = classifyStaticModuleSpecifier(specifier.specifier, DYNAMICS_STATIC_CLOSURE_POLICY);
  if (kind === "package") {
    await validateStaticPackageSearchPaths(specifier.specifier, importer.fileName, projectRoot);
  }
  const needsRuntimeBytes = purpose === "runtime" && specifier.kind === "module"
    && specifier.mode === "runtime"
    && !isDeclarationFile(importer.fileName);
  const resolved = specifier.kind === "type-reference"
    ? ts.resolveTypeReferenceDirective(specifier.specifier, importer.fileName, staticResolutionOptions, readGuard.preflightResolutionHost).resolvedTypeReferenceDirective
    : ts.resolveModuleName(specifier.specifier, importer.fileName,
      needsRuntimeBytes ? staticRuntimeResolutionOptions : staticResolutionOptions,
      readGuard.preflightResolutionHost).resolvedModule;
  if (!resolved?.resolvedFileName && specifier.kind === "module"
    && kind === "relative") {
    return path.resolve(path.dirname(importer.fileName), specifier.specifier);
  }
  const packageEntry = !resolved?.resolvedFileName && specifier.kind === "module"
    ? await checkedProjectPackageEntry(specifier.specifier, projectRoot) : undefined;
  if (!resolved?.resolvedFileName && !packageEntry) throw new Error(`dynamics build has incomplete static resolution evidence: ${specifier.specifier}`);
  return resolved?.resolvedFileName ?? packageEntry;
};

const preflightSources = async (
  entries: readonly string[],
  projectRoot: string,
  readGuard: StaticCompilerReadGuard,
  snapshot: DynamicsBuildSourceSnapshot,
  checkStaticSource = true,
  purpose: StaticResolutionPurpose = "runtime"
): Promise<readonly RuntimeSourceBinding[]> =>
  preflightStaticGraph(entries, DYNAMICS_STATIC_CLOSURE_POLICY, {
    edge: (importer, target, specifier) => {
      if (specifier.specifier === simfileDynamics.moduleSpecifier) return;
      const kind = specifier.kind === "path-reference" ? "relative" : classifyStaticModuleSpecifier(specifier.specifier, DYNAMICS_STATIC_CLOSURE_POLICY);
      assertStaticOwnershipEdge(importer.boundary, target.boundary, kind, specifier.specifier);
      if (kind === "package" && target.kind !== "package") throw new Error(`dynamics build resolved a package import through a non-package path: ${specifier.specifier}`);
    },
    inspect: (source, text) => {
      if (source.kind === "project" && source.fileName.endsWith(ambiguousJavaScriptExtension)) {
        throw new Error(`dynamics build rejects ambiguous authored ${ambiguousJavaScriptExtension} source: ${source.fileName}`);
      }
      if (isRejectedRuntimeTypeScriptSource(source.fileName)) throw new Error(`dynamics build rejects unsupported reachable TypeScript source: ${source.fileName}`);
      assertNoRuntimeDynamicsSurface(source.fileName, text);
      if (checkStaticSource) try {
        assertStaticSource(source.fileName, text, DYNAMICS_STATIC_CLOSURE_POLICY);
      } catch (error) {
        const builtin = error instanceof Error ? /static source uses an unapproved node builtin: (.+)$/.exec(error.message) : null;
        if (builtin?.[1] !== undefined) {
          throw new Error(`unsupported external import: ${builtin[1]}`);
        }
        throw error;
      }
    },
    read: async (fileName) => {
      readGuard.assertPreflightRead(fileName);
      return snapshot.readText(fileName);
    },
    resolve: (specifier, importer) =>
      resolveStaticGraphSpecifier(specifier, importer, projectRoot, readGuard, purpose),
    validate: (fileName) => validateRuntimeSource(fileName, projectRoot, snapshot)
  });

/**
 * Prepares a deterministic, in-memory closure without importing authored code
 * or invoking provider factories.
 */
/** @internal Injects retained-byte authority for deterministic boundary tests. */
export const prepareDynamicsBuildWithSourceSnapshot = async (
  simfilePath: string,
  moduleReference: string,
  sourceSnapshot: DynamicsBuildSourceSnapshot
): Promise<PreparedDynamicsBuild> => {
  const resolved = await resolveDynamicsModule(simfilePath, moduleReference);
  const typeRoots = dynamicsConfiguredTypeRoots();
  const readGuard = createStaticCompilerReadGuard([
    resolved.projectRoot,
    path.dirname(path.dirname(resolved.projectRoot)),
    ...typeRoots.map((root) => path.dirname(root)),
    ...typeRoots.map((root) => path.dirname(path.dirname(root))),
    path.dirname(path.dirname(dynamicsTypeSurfacePath()))
  ], dynamicsDefaultLibraryRoot(), { ...ts.sys, readFile: sourceSnapshot.readTextSync });
  const preflighted = await preflightSources(
    [resolved.absolutePath], resolved.projectRoot, readGuard, sourceSnapshot);
  const sourceBindings = new Map(preflighted.map((source) => [source.fileName, source]));
  const expectedRuntimeInputs = await preflightStaticRuntimeGraph(
    [preflighted[0] as RuntimeSourceBinding], sourceBindings,
    async (fileName) => {
      readGuard.assertPreflightRead(fileName);
      return sourceSnapshot.readText(fileName);
    },
    async (specifier, importer) => specifier.specifier === simfileDynamics.moduleSpecifier
      ? undefined
      : resolveStaticGraphSpecifier(specifier, importer, resolved.projectRoot, readGuard, "runtime")
  );
  const result = await build({
    absWorkingDir: resolved.projectRoot,
    bundle: DYNAMICS_BUILD_CONTRACT.esbuild.bundle,
    charset: DYNAMICS_BUILD_CONTRACT.esbuild.charset,
    entryPoints: [resolved.module.slice(2)],
    external: [...DYNAMICS_STATIC_CLOSURE_POLICY.specifier.approvedNodeBuiltins],
    format: DYNAMICS_BUILD_CONTRACT.esbuild.format,
    ignoreAnnotations: esbuildPolicy.ignoreAnnotations,
    legalComments: DYNAMICS_BUILD_CONTRACT.esbuild.legalComments,
    metafile: true,
    outfile: "dynamics.mjs",
    platform: DYNAMICS_BUILD_CONTRACT.esbuild.platform,
    preserveSymlinks: staticPreserveSymlinks(),
    plugins: [{
      name: "simfile-dynamics-runtime-forbidden",
      setup: (pluginBuild) => {
        pluginBuild.onLoad({ filter: /.*/, namespace: "file" }, async (argument) => {
          const source = await validateRuntimeSource(
            argument.path, resolved.projectRoot, sourceSnapshot);
          if (!expectedRuntimeInputs.has(source.fileName)) throw new Error(`esbuild attempted a runtime read absent from immutable preflight evidence: ${source.fileName}`);
          assertStaticSourceFileName(source.fileName, DYNAMICS_STATIC_CLOSURE_POLICY);
          if (isDeclarationFile(source.fileName)) return;
          const text = await sourceSnapshot.readText(source.fileName);
          try {
            assertNoRuntimeDynamicsSurface(source.fileName, text);
            assertStaticSource(source.fileName, text, DYNAMICS_STATIC_CLOSURE_POLICY);
          } catch (error: unknown) {
            if (error instanceof Error) {
              const unsupportedNodeBuiltinMatch = /static source uses an unapproved node builtin: (.+)$/.exec(error.message);
              if (unsupportedNodeBuiltinMatch?.[1] !== undefined) {
                throw new Error(`unsupported external import: ${unsupportedNodeBuiltinMatch[1]}`);
              }
            }
            throw error;
          }
          const contents = isTransformableTypeScriptSource(source.fileName)
            ? ts.transpileModule(text, {
              compilerOptions: { module: transpileModuleCompilerOptions.module, target: transpileModuleCompilerOptions.target }
            }).outputText
            : text;
          return {
            contents,
            loader: esbuildPolicy.onLoadTranspile.loader
          };
        });
        pluginBuild.onResolve({ filter: simfileSpecifierPattern }, () => ({
          errors: [{ text: simfileDynamics.runtimeResolutionFailure }]
        }));
      }
    }],
    sourcemap: DYNAMICS_BUILD_CONTRACT.esbuild.sourcemap,
    splitting: false,
    target: DYNAMICS_BUILD_CONTRACT.esbuild.target,
    tsconfigRaw: {
      compilerOptions: {
        ...DYNAMICS_BUILD_CONTRACT.typescript,
        allowImportingTsExtensions: typescriptPolicy.compilerOptions.allowImportingTsExtensions,
        module: typescriptPolicy.compilerOptions.module,
        moduleResolution: typescriptPolicy.compilerOptions.moduleResolution,
        target: typescriptPolicy.compilerOptions.target,
        allowJs: typescriptPolicy.allowJs,
        checkJs: typescriptPolicy.checkJs
      }
    },
    write: false
  });

  if (!result.metafile) throw new Error("esbuild did not produce the fixed dynamics output");
  const output = result.outputFiles.find((file) => path.basename(file.path) === "dynamics.mjs") ?? result.outputFiles[0];
  if (!output) throw new Error("esbuild did not produce the fixed dynamics output");
  const outputImports = Object.entries(result.metafile.outputs).flatMap(([, outputMetadata]) =>
    [...(outputMetadata.imports ?? [])]
  ) as StaticImportRecord[];
  assertStaticEmittedEsm(output.path, new TextDecoder().decode(output.contents), DYNAMICS_STATIC_CLOSURE_POLICY);
  const nodeExternals = auditStaticMetafileImports(outputImports, DYNAMICS_STATIC_CLOSURE_POLICY);

  const uniqueRuntimeInputs = [...new Set(Object.keys(result.metafile.inputs).map((input) => path.resolve(resolved.projectRoot, input)))]
    .sort(compareUtf16);

  assertExactRuntimeInputs(expectedRuntimeInputs, uniqueRuntimeInputs);

  const modeEntries = new Map<string, Set<InputMode>>(uniqueRuntimeInputs.map((fileName) => [fileName, new Set<InputMode>(["runtime"]) ]));

  for (const [input, imports] of Object.entries(result.metafile.inputs)) {
    const importer = sourceBindings.get(path.resolve(resolved.projectRoot, input));
    if (!importer) throw new Error(`runtime source was not preflighted for import checks: ${input}`);
    for (const imported of imports.imports as StaticImportRecord[] | undefined ?? []) {
      if (imported.external) continue;
      if (typeof imported.original !== "string" || typeof imported.path !== "string") throw new Error("dynamics build has incomplete import resolution evidence");
      const target = sourceBindings.get(path.resolve(resolved.projectRoot, imported.path));
      if (!target) throw new Error(`runtime import was not independently preflighted: ${imported.original}`);
      const kind = classifyStaticModuleSpecifier(imported.original, DYNAMICS_STATIC_CLOSURE_POLICY);
      assertStaticOwnershipEdge(importer.boundary, target.boundary, kind, imported.original);
    }
  }

  const typecheckMode = uniqueRuntimeInputs.some(isTypeScriptFamily) ? "typescript" as const : "none" as const;
  const typePreflight = typecheckMode === "typescript"
    ? await preflightSources([
      ...preflighted.filter((source) => isTypeScriptFamily(source.fileName)).map((source) => source.fileName),
      dynamicsTypeSurfacePath(),
      ...dynamicsConfiguredTypeEntries(readGuard.preflightResolutionHost)
    ], resolved.projectRoot, readGuard, sourceSnapshot, false, "typecheck")
    : [];
  for (const source of typePreflight) sourceBindings.set(source.fileName, source);
  const declarationBackedRoots = declarationBackedRuntimeRoots(
    uniqueRuntimeInputs,
    sourceBindings,
    typePreflight,
    [...typePreflight].flatMap((source) => {
      if (!source.fileName.endsWith(".d.ts")) return [];
      const text = sourceSnapshot.readTextSync(source.fileName) ?? "";
      const markerStart = text.indexOf("DYNAMICS_DECLARATION_BACKED_MODULES");
      const marker = text.slice(markerStart, text.indexOf(";", markerStart) + 1);
      return [...marker.matchAll(/"([^"]+[.]mjs)"/gu)].map((match) =>
        path.resolve(path.dirname(source.fileName), match[1] as string));
    }));
  const typecheck = typecheckMode === "typescript"
    ? typecheckDynamicsModule(resolved.absolutePath, resolved.projectRoot,
      uniqueRuntimeInputs, readGuard, declarationBackedRoots)
    : undefined;

  for (const fileName of typecheck?.inputPaths ?? []) {
    const checked = await validateRuntimeSource(
      fileName, resolved.projectRoot, sourceSnapshot);
    const modes = modeEntries.get(checked.fileName) ?? new Set<InputMode>();
    modes.add("type-only");
    modeEntries.set(checked.fileName, modes);
    sourceBindings.set(checked.fileName, checked);
  }

  let simfileTypeSurface: Readonly<{ files: readonly string[]; identity: PackageIdentity }> | undefined;
  if (typecheck?.typeSurface) {
    const identity = await enclosingPackageFor(
      typecheck.typeSurface.root, sourceSnapshot.readBytes);
    if (!identity || identity.name !== "simfile") throw new Error("Simfile dynamics type surface has no simfile package identity");
    const files = [...modeEntries.keys()].filter((fileName) => {
      const source = sourceBindings.get(fileName);
      return source?.kind === "package" && source.identity?.directory === identity.directory;
    }).sort(compareUtf16);
    const included = new Set(files);
    for (const typeSurfaceFile of typecheck.typeSurface.files) {
      const validated = await validateRuntimeSource(
        typeSurfaceFile, resolved.projectRoot, sourceSnapshot);
      if (!included.has(validated.fileName)) throw new Error(`Simfile dynamics type surface file lacks same-package evidence: ${validated.fileName}`);
    }
    for (const fileName of files) modeEntries.delete(fileName);
    simfileTypeSurface = { files, identity };
  }

  await sourceSnapshot.verifyAll();
  const inputs = await Promise.all([...modeEntries.entries()].map(([fileName, modes]) => {
    const source = sourceBindings.get(fileName);
    if (!source) throw new Error(`runtime source has no ownership evidence: ${fileName}`);
    return descriptorForStaticSource(
      source, modes, resolved.projectRoot, sourceSnapshot.readRetainedBytes);
  }));
  if (simfileTypeSurface) {
    inputs.push(await staticTypeSurfaceDescriptor(
      simfileTypeSurface.files,
      simfileTypeSurface.identity.directory,
      simfileTypeSurface.identity,
      sourceSnapshot.readRetainedBytes
    ));
  }
  const sortedInputs = sortStaticInputs(inputs);
  const closure = createDynamicsClosureIdentity({
    buildContract: DYNAMICS_BUILD_CONTRACT,
    entry: resolved.module,
    esbuildVersion,
    inputs: sortedInputs,
    preparationPolicy: closurePreparationPolicy,
    typecheckMode,
    typescriptVersion: ts.version,
    usedNodeBuiltins: nodeExternals
  });
  const header = new TextEncoder().encode(closure.header);
  const artifact = new Uint8Array(header.length + output.contents.length);
  artifact.set(header);
  artifact.set(output.contents, header.length);
  return deepFreeze({
    artifactBytes: Array.from(artifact),
    artifactSha256: sha256(artifact),
    closureDescriptor: closure.descriptor,
    closureSha256: closure.sha256,
    inputs: sortedInputs,
    module: resolved.module,
    nodeExternals,
    typecheckMode
  });
};

export const prepareDynamicsBuild = (
  simfilePath: string,
  moduleReference: string
): Promise<PreparedDynamicsBuild> => prepareDynamicsBuildWithSourceSnapshot(
  simfilePath,
  moduleReference,
  createDynamicsBuildSourceSnapshot()
);
