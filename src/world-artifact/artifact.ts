import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { compareUtf16, canonicalJson } from "../dynamics/buildIdentity.js";
import { nodeModulesPackageFor } from "../dynamics/buildPackagePolicy.js";
import { createDynamicsBuildSourceSnapshot } from "../dynamics/buildSourceSnapshot.js";
import { staticSourceSpecifiers, type StaticRuntimeSourceBinding } from "../dynamics/buildStaticResolverPolicy.js";
import { auditStaticMetafileImports, classifyStaticModuleSpecifier, DYNAMICS_STATIC_CLOSURE_POLICY, validateStaticSourcePath, type StaticClosurePolicy, type StaticMetafileImport } from "../dynamics/buildStaticPolicy.js";
import { assertWorldArtifactMetafileInputs, assertWorldArtifactRegularAncestors, loadWorldArtifactTools, readWorldArtifactLock, validateWorldArtifactPackage, type WorldArtifactPackageRecord, type WorldArtifactToolRecord } from "./authority.js";
import { boundedInteger, boundedText, exactArray, exactData, frozen, snapshotDataGraph, sortedUniqueText, uniqueText } from "./data.js";

export const WORLD_SERVICE_ARTIFACT_VERSION = "simfile.world-service-artifact.v1" as const;
export const WORLD_SERVICE_CONTRACT_VERSION = "simfile.world-service-contract.v1" as const;
export const WORLD_SERVICE_ENTRYPOINT = "world-artifact/entrypoint.mjs" as const;
export const WORLD_SERVICE_ARTIFACT_LIMITS = Object.freeze({ artifact_bytes: 16 * 1024 * 1024, manifest_bytes: 256 * 1024, source_files: 2048, string_code_units: 512, json_depth: 32 });

type ContractIdentities = Readonly<{ dynamics_provider: string; world_surface: string; capability_manifest: string; world_act_request: string; world_checkpoint: string; world_runtime: string; handler: string; adapters: Readonly<{ json: string; mcp: string }>; operations: readonly string[]; spawnfile_receipts: readonly string[]; world_bindings: string }>;
type WorldServiceBuildTool = Omit<WorldArtifactToolRecord, "name" | "closure">;
export interface WorldServiceContract { readonly version: typeof WORLD_SERVICE_CONTRACT_VERSION; readonly contracts: ContractIdentities; readonly digest: string; }
export interface WorldServiceArtifactFile { readonly kind: "package" | "project"; readonly path: string; readonly bytes: number; readonly digest: string; readonly package?: Readonly<{ name: string; version: string; manifest_digest: string; lock_path: string; lock_digest: string }>; }
export interface WorldServiceArtifactManifest {
  readonly version: typeof WORLD_SERVICE_ARTIFACT_VERSION; readonly entrypoint: typeof WORLD_SERVICE_ENTRYPOINT; readonly contract: WorldServiceContract;
  readonly source_graph_digest: string; readonly source_files: readonly WorldServiceArtifactFile[]; readonly artifact_digest: string; readonly artifact_bytes: number;
  readonly node: Readonly<{ builtins: readonly string[]; node: string; v8: string }>;
  readonly build_tools: Readonly<{ esbuild: WorldServiceBuildTool; typescript: WorldServiceBuildTool }>;
  readonly execution_provenance: Readonly<{ esbuild: WorldArtifactToolRecord["closure"]; typescript: WorldArtifactToolRecord["closure"] }>;
  readonly build_config: Readonly<{ esbuild: Readonly<Record<string, unknown>>; static_policy_digest: string; static_policy: Readonly<Record<string, unknown>> }>;
  readonly digest: string;
}
export interface WorldServiceArtifact { readonly artifact_bytes: readonly number[]; readonly manifest: WorldServiceArtifactManifest; readonly manifest_bytes: readonly number[]; }
export interface CreateWorldServiceArtifactInput { readonly source_root: string; readonly dependency_root: string; readonly contract: WorldServiceContract; }

const encoder = new TextEncoder();
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const digest = (domain: string, value: unknown): string => `sha256:${createHash("sha256").update(canonicalJson({ domain, value })).digest("hex")}`;
const byteDigest = (domain: string, value: Uint8Array): string => `sha256:${createHash("sha256").update(domain).update("\0").update(value).digest("hex")}`;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[], label: string): Record<string, unknown> => exactData(value, keys, label);
const checkedDigest = (value: unknown, label: string): string => {
  const text = boundedText(value, 71, label);
  if (!digestPattern.test(text)) throw new TypeError(`world artifact ${label} must be sha256:<64 lowercase hex>`);
  return text;
};
const contractKeys = ["dynamics_provider", "world_surface", "capability_manifest", "world_act_request", "world_checkpoint", "world_runtime", "handler", "adapters", "operations", "spawnfile_receipts", "world_bindings"] as const;
const staticPolicy: StaticClosurePolicy = frozen({
  ...DYNAMICS_STATIC_CLOSURE_POLICY,
  source: { ...DYNAMICS_STATIC_CLOSURE_POLICY.source, javaScriptExtensions: [...DYNAMICS_STATIC_CLOSURE_POLICY.source.javaScriptExtensions, ".json"], lookupForms: ["static-import", "static-export", "require-direct"] },
  specifier: { ...DYNAMICS_STATIC_CLOSURE_POLICY.specifier, approvedNodeBuiltins: ["node:assert/strict", "node:buffer", "node:child_process", "node:crypto", "node:events", "node:fs", "node:fs/promises", "node:http", "node:module", "node:path", "node:stream", "node:url", "node:util"] }
});
const buildConfig = frozen({ absWorkingDir: "source_root", bundle: true, charset: "utf8", format: "esm", legalComments: "none", metafile: true, outfile: WORLD_SERVICE_ENTRYPOINT, platform: "node", preserveSymlinks: true, sourcemap: false, splitting: false, target: "node22", write: false } as const);

const parseContractIdentities = (value: unknown): ContractIdentities => {
  const record = exactData(value, contractKeys, "contract identities");
  const text = (key: keyof ContractIdentities): string => boundedText(record[key], WORLD_SERVICE_ARTIFACT_LIMITS.string_code_units, `contract.${key}`);
  const adapters = exactData(record.adapters, ["json", "mcp"], "contract.adapters");
  return frozen({ dynamics_provider: text("dynamics_provider"), world_surface: text("world_surface"), capability_manifest: text("capability_manifest"), world_act_request: text("world_act_request"), world_checkpoint: text("world_checkpoint"), world_runtime: text("world_runtime"), handler: text("handler"), adapters: frozen({ json: boundedText(adapters.json, 512, "contract.adapters.json"), mcp: boundedText(adapters.mcp, 512, "contract.adapters.mcp") }), operations: uniqueText(record.operations, 64, 128, "contract.operations"), spawnfile_receipts: uniqueText(record.spawnfile_receipts, 64, 128, "contract.spawnfile_receipts"), world_bindings: text("world_bindings") });
};
const parseContract = (value: unknown): WorldServiceContract => {
  const record = exactData(snapshotDataGraph(value, "contract"), ["version", "contracts", "digest"], "contract");
  if (record.version !== WORLD_SERVICE_CONTRACT_VERSION) throw new TypeError("world artifact contract version is invalid");
  const contracts = parseContractIdentities(record.contracts);
  const expected = digest("world-service-contract.v1", { version: WORLD_SERVICE_CONTRACT_VERSION, contracts });
  if (checkedDigest(record.digest, "contract.digest") !== expected) throw new TypeError("world artifact contract digest mismatch");
  return frozen({ version: WORLD_SERVICE_CONTRACT_VERSION, contracts, digest: expected });
};

export const createWorldServiceContract = (contracts: unknown): WorldServiceContract => {
  const copied = parseContractIdentities(snapshotDataGraph(contracts, "contract identities"));
  return frozen({ version: WORLD_SERVICE_CONTRACT_VERSION, contracts: copied, digest: digest("world-service-contract.v1", { version: WORLD_SERVICE_CONTRACT_VERSION, contracts: copied }) });
};

const portable = (value: string, label: string): string => {
  if (!/^[A-Za-z0-9@][A-Za-z0-9@._/-]*$/u.test(value) || value.includes("//") || value.includes("..")) throw new TypeError(`world artifact ${label} is not portable`);
  return value;
};
const parseFile = (value: unknown, seen: WeakSet<object>): WorldServiceArtifactFile => {
  if (value === null || typeof value !== "object" || seen.has(value as object)) throw new TypeError("world artifact source file is aliased");
  seen.add(value as object);
  const preliminary = exactData(value, ["kind", "path", "bytes", "digest", "package"].filter((key) => Object.hasOwn(value, key)), "source file");
  const packageFile = preliminary.kind === "package";
  const record = exactKeys(preliminary, packageFile ? ["kind", "path", "bytes", "digest", "package"] : ["kind", "path", "bytes", "digest"], "source file");
  if (record.kind !== "project" && record.kind !== "package") throw new TypeError("world artifact source kind is invalid");
  const base = { kind: record.kind, path: portable(boundedText(record.path, 1024, "source path"), "source path"), bytes: boundedInteger(record.bytes, 1, WORLD_SERVICE_ARTIFACT_LIMITS.artifact_bytes, "source bytes"), digest: checkedDigest(record.digest, "source digest") } as const;
  if (record.kind === "project") return frozen(base);
  const packageRecord = exactData(record.package, ["name", "version", "manifest_digest", "lock_path", "lock_digest"], "source package");
  return frozen({ ...base, kind: "package" as const, package: frozen({ name: boundedText(packageRecord.name, 256, "package name"), version: boundedText(packageRecord.version, 256, "package version"), manifest_digest: checkedDigest(packageRecord.manifest_digest, "package manifest digest"), lock_path: portable(boundedText(packageRecord.lock_path, 512, "package lock path"), "package lock path"), lock_digest: checkedDigest(packageRecord.lock_digest, "package lock digest") }) });
};
const parseManifest = (value: unknown): WorldServiceArtifactManifest => {
  value = snapshotDataGraph(value, "manifest", WORLD_SERVICE_ARTIFACT_LIMITS.source_files * 8);
  const seen = new WeakSet<object>();
  if (value === null || typeof value !== "object") throw new TypeError("world artifact manifest is unsafe"); seen.add(value as object);
  const record = exactData(value, ["version", "entrypoint", "contract", "source_graph_digest", "source_files", "artifact_digest", "artifact_bytes", "node", "build_tools", "execution_provenance", "build_config", "digest"], "manifest");
  if (record.version !== WORLD_SERVICE_ARTIFACT_VERSION || record.entrypoint !== WORLD_SERVICE_ENTRYPOINT) throw new TypeError("world artifact manifest version is invalid");
  const contract = parseContract(record.contract);
  const sourceRaw = exactArray(record.source_files, WORLD_SERVICE_ARTIFACT_LIMITS.source_files, "source files");
  if (sourceRaw.length === 0) throw new TypeError("world artifact source files are empty");
  const sourceFiles = sourceRaw.map((file) => parseFile(file, seen));
  if (sourceFiles.some((file, index) => index > 0 && compareUtf16((sourceFiles[index - 1] as WorldServiceArtifactFile).path, file.path) >= 0)) throw new TypeError("world artifact source paths are not unique");
  const node = exactData(record.node, ["builtins", "node", "v8"], "node identity");
  const tools = exactData(record.build_tools, ["esbuild", "typescript"], "build tools");
  const parseToolFile = (value: unknown, label: string): WorldServiceBuildTool["entry"] => {
    const item = exactData(value, ["path", "bytes", "digest"], label);
    return frozen({ path: portable(boundedText(item.path, 1024, `${label}.path`), `${label}.path`), bytes: boundedInteger(item.bytes, 1, WORLD_SERVICE_ARTIFACT_LIMITS.artifact_bytes, `${label}.bytes`), digest: checkedDigest(item.digest, `${label}.digest`) });
  };
  const parseClosure = (value: unknown, label: string, entry: WorldServiceBuildTool["entry"], type: "esbuild" | "typescript"): WorldArtifactToolRecord["closure"] => {
    const item = exactData(value, ["files", "digest"], label); const files = exactArray(item.files, 2, `${label}.files`).map((file, index) => parseToolFile(file, `${label}.files[${index}]`));
    const expected = type === "typescript" ? 1 : 2;
    if (files.length !== expected || files.some((file, index) => index > 0 && compareUtf16(files[index - 1]!.path, file.path) >= 0) || !files.some((file) => canonicalJson(file) === canonicalJson(entry))) throw new TypeError(`world artifact ${label} is invalid`);
    if (type === "typescript" && entry.path !== "node_modules/typescript/lib/typescript.js") throw new TypeError("world artifact typescript entry is invalid");
    if (type === "esbuild" && (entry.path !== "node_modules/esbuild/lib/main.js" || !files.some((file) => file.path.startsWith("node_modules/@esbuild/") && /(?:^|\/)esbuild(?:\.exe)?$/u.test(file.path)))) throw new TypeError("world artifact esbuild closure is invalid");
    const expectedDigest = `sha256:${createHash("sha256").update(canonicalJson({ domain: "world-artifact-tool-closure.v1", files })).digest("hex")}`;
    if (checkedDigest(item.digest, `${label}.digest`) !== expectedDigest) throw new TypeError(`world artifact ${label} digest mismatch`);
    return frozen({ files: frozen(files), digest: expectedDigest });
  };
  const parseTool = (value: unknown, label: string, type: "esbuild" | "typescript"): WorldServiceBuildTool => {
    const item = exactData(value, ["version", "manifest_digest", "lock_path", "lock_digest", "entry"], label);
    const record = frozen({ version: boundedText(item.version, 256, `${label}.version`), manifest_digest: checkedDigest(item.manifest_digest, `${label}.manifest_digest`), lock_path: portable(boundedText(item.lock_path, 512, `${label}.lock_path`), `${label}.lock_path`), lock_digest: checkedDigest(item.lock_digest, `${label}.lock_digest`), entry: parseToolFile(item.entry, `${label}.entry`) });
    if (record.lock_path !== `node_modules/${type}` || record.entry.path !== `${record.lock_path}/${type === "typescript" ? "lib/typescript.js" : "lib/main.js"}`) throw new TypeError(`world artifact ${label} path is invalid`);
    return record;
  };
  const execution = exactData(record.execution_provenance, ["esbuild", "typescript"], "execution provenance");
  const config = exactData(record.build_config, ["esbuild", "static_policy_digest", "static_policy"], "build config");
  const esbuild = exactData(config.esbuild, Object.keys(buildConfig), "esbuild config");
  const policy = exactData(config.static_policy, ["build", "emitted", "metafile", "path", "source", "specifier"], "static policy");
  if (canonicalJson(esbuild) !== canonicalJson(buildConfig) || canonicalJson(policy) !== canonicalJson(staticPolicy)) throw new TypeError("world artifact build configuration is invalid");
  const parsedEsbuild = parseTool(tools.esbuild, "esbuild tool", "esbuild"); const parsedTypescript = parseTool(tools.typescript, "typescript tool", "typescript");
  const executionProvenance = frozen({ esbuild: parseClosure(execution.esbuild, "esbuild execution", parsedEsbuild.entry, "esbuild"), typescript: parseClosure(execution.typescript, "typescript execution", parsedTypescript.entry, "typescript") });
  const unsigned = { version: WORLD_SERVICE_ARTIFACT_VERSION, entrypoint: WORLD_SERVICE_ENTRYPOINT, contract, source_graph_digest: checkedDigest(record.source_graph_digest, "source graph digest"), source_files: sourceFiles, artifact_digest: checkedDigest(record.artifact_digest, "artifact digest"), artifact_bytes: boundedInteger(record.artifact_bytes, 1, WORLD_SERVICE_ARTIFACT_LIMITS.artifact_bytes, "artifact bytes"), node: frozen({ builtins: sortedUniqueText(node.builtins, 64, 128, "node builtins"), node: boundedText(node.node, 256, "node version"), v8: boundedText(node.v8, 256, "v8 version") }), build_tools: frozen({ esbuild: parsedEsbuild, typescript: parsedTypescript }), execution_provenance: executionProvenance, build_config: frozen({ esbuild: frozen(esbuild), static_policy_digest: checkedDigest(config.static_policy_digest, "static policy digest"), static_policy: frozen(policy) }) };
  if (unsigned.build_config.static_policy_digest !== digest("world-service-static-policy.v1", staticPolicy)) throw new TypeError("world artifact static policy digest mismatch");
  if (checkedDigest(record.digest, "manifest digest") !== digest("world-service-manifest.v1", unsigned)) throw new TypeError("world artifact manifest digest mismatch");
  return frozen({ ...unsigned, digest: digest("world-service-manifest.v1", unsigned) });
};
export const serializeWorldServiceArtifactManifest = (manifest: WorldServiceArtifactManifest): Uint8Array => encoder.encode(`${canonicalJson(parseManifest(manifest))}\n`);
export const parseWorldServiceArtifactManifest = (value: unknown): WorldServiceArtifactManifest => parseManifest(value);
export function assertWorldServiceArtifactManifest(value: unknown): asserts value is WorldServiceArtifactManifest { parseManifest(value); }

interface SourceBinding extends StaticRuntimeSourceBinding { readonly packageRecord?: WorldArtifactPackageRecord; }
type ExactBuild = (options: object) => Promise<Readonly<{
  metafile?: Readonly<{ inputs: Record<string, unknown>; outputs: Record<string, Readonly<{ imports?: readonly StaticMetafileImport[] }>> }>;
  outputFiles?: readonly Readonly<{ contents: Uint8Array }>[];
}>>;
type ExactCompiler = typeof import("typescript");
const literal = (compiler: ExactCompiler, value: unknown): string | undefined =>
  compiler.isStringLiteral(value as never) || compiler.isNoSubstitutionTemplateLiteral(value as never) ? (value as { text: string }).text : undefined;
const assertExactStaticSource = (fileName: string, text: string, compiler: ExactCompiler): void => {
  const kind = fileName.endsWith(".ts") ? compiler.ScriptKind.TS : compiler.ScriptKind.JS;
  const source = compiler.createSourceFile(fileName, text, compiler.ScriptTarget.ES2022, true, kind);
  if ((source as unknown as { parseDiagnostics: readonly unknown[] }).parseDiagnostics.length) throw new TypeError(`world artifact source does not parse: ${fileName}`);
  const visit = (node: import("typescript").Node): void => {
    if (compiler.isImportDeclaration(node) || compiler.isExportDeclaration(node)) {
      if (node.moduleSpecifier && literal(compiler, node.moduleSpecifier) === undefined) throw new TypeError("world artifact source has nonliteral module lookup");
    } else if (compiler.isImportEqualsDeclaration(node) && compiler.isExternalModuleReference(node.moduleReference)) {
      if (literal(compiler, node.moduleReference.expression) === undefined) throw new TypeError("world artifact source has nonliteral module lookup");
    } else if (compiler.isCallExpression(node) && node.expression.kind === compiler.SyntaxKind.ImportKeyword) {
      throw new TypeError("world artifact source has dynamic import");
    } else if (compiler.isCallExpression(node) && compiler.isIdentifier(node.expression) && node.expression.text === "require") {
      if (node.arguments.length !== 1 || literal(compiler, node.arguments[0]) === undefined) throw new TypeError("world artifact source has unsafe require");
    }
    compiler.forEachChild(node, visit);
  };
  visit(source);
};
const assertExactEmittedEsm = (text: string, compiler: ExactCompiler): void => {
  const source = compiler.createSourceFile(WORLD_SERVICE_ENTRYPOINT, text, compiler.ScriptTarget.ES2022, true, compiler.ScriptKind.JS);
  if ((source as unknown as { parseDiagnostics: readonly unknown[] }).parseDiagnostics.length) throw new TypeError("world artifact emitted ESM does not parse");
  const visit = (node: import("typescript").Node): void => {
    if ((compiler.isImportDeclaration(node) || compiler.isExportDeclaration(node)) && node.moduleSpecifier) {
      const specifier = literal(compiler, node.moduleSpecifier);
      if (specifier === undefined || classifyStaticModuleSpecifier(specifier, staticPolicy) !== "node-builtin") throw new TypeError("world artifact emitted ESM has residual package lookup");
    }
    if (compiler.isCallExpression(node) && node.expression.kind === compiler.SyntaxKind.ImportKeyword) throw new TypeError("world artifact emitted ESM has dynamic import");
    compiler.forEachChild(node, visit);
  };
  visit(source);
};

/** Produces an immutable, hermetic ESM closure; deployment persists it later. */
export const createWorldServiceArtifact = async (input: CreateWorldServiceArtifactInput): Promise<WorldServiceArtifact> => {
  const outer = exactData(snapshotDataGraph(input, "input"), ["source_root", "dependency_root", "contract"], "input");
  const sourceRoot = boundedText(outer.source_root, 4096, "source root");
  const dependencyRoot = boundedText(outer.dependency_root, 4096, "dependency root");
  if (!path.isAbsolute(sourceRoot) || !path.isAbsolute(dependencyRoot)) throw new TypeError("world artifact roots are not absolute");
  const contract = parseContract(outer.contract); // Authority is complete before any build or source read.
  const root = await assertWorldArtifactRegularAncestors(sourceRoot);
  const snapshot = createDynamicsBuildSourceSnapshot();
  const lockAuthority = await readWorldArtifactLock(root, snapshot);
  const dependency = await assertWorldArtifactRegularAncestors(dependencyRoot);
  const tools = await loadWorldArtifactTools(root, dependency, lockAuthority.lock, lockAuthority.lockDigest, snapshot);
  const compiler = tools.typescript.entry as ExactCompiler;
  const bundler = tools.esbuild.entry.build;
  if (typeof bundler !== "function") throw new TypeError("world artifact esbuild tool is invalid");
  const bindings = new Map<string, SourceBinding>();
  const validate = async (fileName: string): Promise<SourceBinding> => {
    const candidate = path.resolve(fileName); const existing = bindings.get(candidate); if (existing) return existing;
    const relative = path.relative(root, candidate);
    if (!relative.startsWith(`node_modules${path.sep}`) && !await nodeModulesPackageFor(candidate, snapshot.readBytes)) {
      const validated = await validateStaticSourcePath(candidate, root, staticPolicy);
      const binding: SourceBinding = { fileName: validated, boundary: root, kind: "project" }; bindings.set(validated, binding); return binding;
    }
    const packageSource = await validateWorldArtifactPackage(root, dependency, candidate, lockAuthority.lock, lockAuthority.lockDigest, snapshot);
    const binding: SourceBinding = { fileName: candidate, boundary: packageSource.boundary, identity: packageSource.identity, kind: "package", packageRecord: packageSource.record }; bindings.set(candidate, binding); return binding;
  };
  const resolve = async (specifier: string, importer: SourceBinding): Promise<string | undefined> => {
    const kind = classifyStaticModuleSpecifier(specifier, staticPolicy); if (kind === "node-builtin") return undefined;
    if (kind === "relative") { const raw = path.resolve(path.dirname(importer.fileName), specifier); const candidates = [raw, raw.endsWith(".js") ? `${raw.slice(0, -3)}.ts` : raw, `${raw}.js`, `${raw}.mjs`, `${raw}.ts`, path.join(raw, "index.js"), path.join(raw, "index.mjs")]; for (const candidate of [...new Set(candidates)]) try { if ((await lstat(candidate)).isFile()) return candidate; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } throw new TypeError(`world artifact relative source is missing: ${specifier}`); }
    const parts = specifier.split("/"); const packageName = specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
    if (!packageName) throw new TypeError("world artifact package specifier is invalid");
    const resolved = createRequire(importer.fileName).resolve(specifier);
    const resolvedPackage = await validateWorldArtifactPackage(root, dependency, resolved, lockAuthority.lock, lockAuthority.lockDigest, snapshot);
    if (resolvedPackage.identity.name !== packageName) throw new TypeError(`world artifact package escaped exact identity: ${specifier}`);
    return resolvedPackage.fileName;
  };
  const entry = path.join(root, "src", "world-artifact", "entrypoint.ts");
  const preflighted: SourceBinding[] = []; const queued = [entry]; const visited = new Set<string>();
  for (let index = 0; index < queued.length; index += 1) {
    const source = await validate(queued[index] as string); if (visited.has(source.fileName)) continue; visited.add(source.fileName); preflighted.push(source);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await snapshot.readBytes(source.fileName));
    if (source.fileName.endsWith(".json")) continue;
    assertExactStaticSource(source.fileName, text, compiler);
    for (const specifier of staticSourceSpecifiers(source.fileName, text, staticPolicy, compiler)) {
      if (specifier.mode === "type-only") continue;
      const targetName = await resolve(specifier.specifier, source); if (targetName === undefined) continue;
      const target = await validate(targetName);
      if (specifier.specifier.startsWith(".") && source.boundary !== target.boundary) throw new TypeError("world artifact relative import escaped its owner");
      if (!visited.has(target.fileName)) queued.push(target.fileName);
    }
  }
  const expected = new Set(preflighted.map((item) => item.fileName));
  const result = await (bundler as ExactBuild)({ ...buildConfig, absWorkingDir: root, entryPoints: [entry], external: [...staticPolicy.specifier.approvedNodeBuiltins], plugins: [{ name: "world-artifact-authority", setup: (plugin: { onResolve(options: object, callback: (argument: { kind: string; path: string; importer: string }) => unknown): void; onLoad(options: object, callback: (argument: { path: string }) => unknown): void }) => { plugin.onResolve({ filter: /.*/ }, async (argument) => { if (argument.kind === "entry-point") return undefined; if (argument.path.startsWith("node:")) return { path: argument.path, external: true }; const importer = await validate(argument.importer); const target = await resolve(argument.path, importer); return target === undefined ? { path: argument.path, external: true } : { path: target }; }); plugin.onLoad({ filter: /.*/ }, async (argument) => { const source = await validate(argument.path); if (!expected.has(source.fileName)) throw new TypeError(`world artifact build read absent from preflight: ${source.fileName}`); const text = new TextDecoder("utf-8", { fatal: true }).decode(await snapshot.readBytes(source.fileName)); if (!source.fileName.endsWith(".json")) assertExactStaticSource(source.fileName, text, compiler); return { contents: text, loader: source.fileName.endsWith(".json") ? "json" : source.fileName.endsWith(".ts") ? "ts" : "js" }; }); } }] });
  await snapshot.verifyAll();
  const outputs = result.outputFiles;
  if (!result.metafile || !outputs || outputs.length !== 1 || !outputs[0]) throw new TypeError("world artifact requires one emitted output");
  const artifact = outputs[0].contents; if (artifact.byteLength > WORLD_SERVICE_ARTIFACT_LIMITS.artifact_bytes) throw new TypeError("world artifact exceeds byte limit");
  assertExactEmittedEsm(new TextDecoder("utf-8", { fatal: true }).decode(artifact), compiler);
  assertWorldArtifactMetafileInputs(expected, Object.keys(result.metafile.inputs), root);
  const sourcePath = (source: SourceBinding): string => source.kind === "project"
    ? `project/${portable(path.relative(root, source.fileName).split(path.sep).join("/"), "project path")}`
    : `package/${portable(`${source.packageRecord?.lock_path}/${path.relative(source.boundary, source.fileName).split(path.sep).join("/")}`, "package path")}`;
  const sourceFiles = [...expected].map((fileName) => { const source = bindings.get(fileName); if (!source) throw new TypeError("world artifact source binding disappeared"); return frozen({ kind: source.kind, path: sourcePath(source), bytes: 0, digest: "", ...(source.kind === "package" ? { package: source.packageRecord } : {}) }); }).sort((left, right) => compareUtf16(left.path, right.path));
  if (sourceFiles.some((file, index) => index > 0 && file.path === sourceFiles[index - 1]?.path)) throw new TypeError("world artifact source path is ambiguous");
  const sources = await Promise.all(sourceFiles.map(async (file) => { const original = [...bindings.values()].find((item) => sourcePath(item) === file.path); if (!original) throw new TypeError("world artifact source descriptor is ambiguous"); const bytes = await snapshot.readRetainedBytes(original.fileName); return frozen({ ...file, bytes: bytes.byteLength, digest: byteDigest("world-service-source.v1", bytes) }); }));
  const builtins = auditStaticMetafileImports(Object.values(result.metafile.outputs).flatMap((output) => output.imports ?? []), staticPolicy);
  const toolRecord = (tool: typeof tools.esbuild): WorldServiceBuildTool => {
    const { name: _name, closure: _closure, ...record } = tool.record;
    return frozen(record);
  };
  const buildTools = frozen({ esbuild: toolRecord(tools.esbuild), typescript: toolRecord(tools.typescript) });
  const executionClosure = (closure: WorldArtifactToolRecord["closure"]): WorldArtifactToolRecord["closure"] => frozen({ files: frozen(closure.files.map((file) => frozen({ ...file }))), digest: closure.digest });
  const executionProvenance = frozen({ esbuild: executionClosure(tools.esbuild.record.closure), typescript: executionClosure(tools.typescript.record.closure) });
  const config = frozen({ esbuild: buildConfig, static_policy_digest: digest("world-service-static-policy.v1", staticPolicy), static_policy: staticPolicy });
  const graph = frozen({ entrypoint: WORLD_SERVICE_ENTRYPOINT, sources, builtins, build_tools: buildTools, build_config: config, lock_digest: `sha256:${lockAuthority.lockDigest}` });
  const unsigned = { version: WORLD_SERVICE_ARTIFACT_VERSION, entrypoint: WORLD_SERVICE_ENTRYPOINT, contract, source_graph_digest: digest("world-service-source-graph.v1", graph), source_files: sources, artifact_digest: byteDigest("world-service-artifact.v1", artifact), artifact_bytes: artifact.byteLength, node: frozen({ builtins, node: process.versions.node, v8: process.versions.v8 }), build_tools: buildTools, execution_provenance: executionProvenance, build_config: config };
  const manifest = parseManifest({ ...unsigned, digest: digest("world-service-manifest.v1", unsigned) });
  const manifestBytes = serializeWorldServiceArtifactManifest(manifest); if (manifestBytes.byteLength > WORLD_SERVICE_ARTIFACT_LIMITS.manifest_bytes) throw new TypeError("world artifact manifest exceeds byte limit");
  return frozen({ artifact_bytes: Object.freeze(Array.from(artifact)), manifest, manifest_bytes: Object.freeze(Array.from(manifestBytes)) });
};
