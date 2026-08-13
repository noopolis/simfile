import { createHash } from "node:crypto";
import { types } from "node:util";

import { canonicalJson, compareUtf16, deepFreeze } from "../dynamics/buildIdentity.js";
import {
  parseWorldServiceArtifactManifest,
  serializeWorldServiceArtifactManifest,
  type WorldServiceArtifact,
  type WorldServiceArtifactManifest,
} from "./artifact.js";
import { WORLD_SIDECAR_RUNTIME_ABI } from "./entrypoint.js";
import {
  parseSimfileScopedSecretIdentifier,
  type WorldSidecarBearerDeclaration,
} from "./secretMount.js";
import { parseWorldSidecarAbsolutePath } from "./sidecarPath.js";

export const RUNNABLE_WORLD_SIDECAR_BUNDLE_VERSION = "simfile.runnable-world-sidecar-bundle.v1" as const;
export const RUNNABLE_WORLD_SIDECAR_ENTRYPOINT = "world-artifact/runner.mjs" as const;
export const RUNNABLE_WORLD_SIDECAR_ARCHIVE_PATHS = Object.freeze([
  "bundle.json", "world-artifact/composer.mjs", "world-artifact/entrypoint.mjs",
  "world-artifact/manifest.json", "world-artifact/provider.mjs", "world-artifact/runner.mjs",
] as const);
export const RUNNABLE_WORLD_SIDECAR_LIMITS = Object.freeze({
  archive_bytes: 48 * 1024 * 1024, artifact_bytes: 24 * 1024 * 1024,
  composer_bytes: 16 * 1024 * 1024, launcher_bytes: 256 * 1024, manifest_bytes: 2 * 1024 * 1024,
  source_files: 4096,
});

export type RunnableWorldSidecarSecret = WorldSidecarBearerDeclaration;
export interface RunnableWorldSidecarFile { readonly path: string; readonly bytes: number; readonly sha256: string; }
export interface RunnableWorldComposerSource { readonly path: string; readonly bytes: number; readonly sha256: string; }
export interface RunnableWorldComposerProvenance {
  readonly version: "simfile.world-composer-build.v1";
  readonly tool: Readonly<{ readonly name: "esbuild"; readonly version: string; readonly closure_digest: string }>;
  readonly config: Readonly<Record<string, unknown>>;
  readonly source_graph: readonly RunnableWorldComposerSource[];
  readonly digest: string;
}
export interface RunnableWorldArtifactBinding extends RunnableWorldSidecarFile {
  readonly service_digest: string;
  readonly manifest: WorldServiceArtifactManifest;
  readonly manifest_file: RunnableWorldSidecarFile;
}
export interface RunnableWorldComposerBinding extends RunnableWorldSidecarFile {
  readonly provenance: RunnableWorldComposerProvenance;
}
export interface RunnableWorldSidecarManifest {
  readonly version: typeof RUNNABLE_WORLD_SIDECAR_BUNDLE_VERSION;
  readonly runtime_abi: typeof WORLD_SIDECAR_RUNTIME_ABI;
  readonly entrypoint: typeof RUNNABLE_WORLD_SIDECAR_ENTRYPOINT;
  readonly network: Readonly<{ readonly dns_alias: string; readonly internal_port: number }>;
  readonly evidence: Readonly<{ readonly root: string }>;
  readonly secrets: Readonly<{
    readonly root: string;
    readonly declarations: readonly RunnableWorldSidecarSecret[];
  }>;
  readonly artifact: RunnableWorldArtifactBinding;
  readonly launcher: RunnableWorldSidecarFile;
  readonly composer: RunnableWorldComposerBinding;
  readonly provider: RunnableWorldSidecarFile;
  readonly digest: string;
}
export interface RunnableWorldSidecarBundle {
  readonly archive_bytes: readonly number[];
  readonly archive_sha256: string;
  readonly manifest: RunnableWorldSidecarManifest;
  readonly manifest_bytes: readonly number[];
}
export interface CreateRunnableWorldSidecarBundleInput {
  readonly artifact: WorldServiceArtifact;
  readonly composer_bytes: Uint8Array;
  readonly composer_provenance: RunnableWorldComposerProvenance;
  readonly provider_bytes: Uint8Array;
  readonly network: Readonly<{ readonly dns_alias: string; readonly internal_port: number }>;
  readonly evidence_root: string;
  readonly secrets: Readonly<{
    readonly root: string;
    readonly declarations: readonly RunnableWorldSidecarSecret[];
  }>;
}

const encoder = new TextEncoder();
const rawSha = (value: Uint8Array): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const domainSha = (domain: string, value: Uint8Array): string =>
  `sha256:${createHash("sha256").update(domain).update("\0").update(value).digest("hex")}`;
const manifestDigest = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalJson({ domain: RUNNABLE_WORLD_SIDECAR_BUNDLE_VERSION, value })).digest("hex")}`;
const sha = (value: unknown): string | undefined => typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value) ? value : undefined;
const fail = (): never => { throw new TypeError("invalid runnable world sidecar bundle"); };
const exact = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const found = Reflect.ownKeys(value);
  if (found.length !== keys.length || found.some((key) => typeof key !== "string" || !keys.includes(key))) return fail();
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    output[key] = descriptor.value;
  }
  return output;
};
const exactBytes = (value: unknown, maximum: number): Uint8Array => {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return fail();
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 1 || length.value > maximum
    || Reflect.ownKeys(value).length !== length.value + 1) return fail();
  const output = new Uint8Array(length.value);
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor) || !Number.isInteger(descriptor.value)
      || descriptor.value < 0 || descriptor.value > 255) return fail();
    output[index] = descriptor.value;
  }
  return output;
};
const portable = (value: unknown): string | undefined => typeof value === "string"
  && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value) && !value.includes("//") && !value.includes("..") ? value : undefined;
const text = (value: unknown, maximum: number): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= maximum && value === value.trim() ? value : undefined;
const parseFile = (value: unknown, expectedPath: string, maximum: number): RunnableWorldSidecarFile => {
  const source = exact(value, ["path", "bytes", "sha256"]); const candidate = portable(source.path);
  if (candidate !== expectedPath || typeof source.bytes !== "number" || !Number.isSafeInteger(source.bytes)
    || source.bytes < 1 || source.bytes > maximum || !sha(source.sha256)) return fail();
  return deepFreeze({ path: candidate, bytes: source.bytes, sha256: source.sha256 as string });
};
const parseSource = (value: unknown): RunnableWorldComposerSource => {
  const source = exact(value, ["path", "bytes", "sha256"]); const candidate = portable(source.path);
  if (!candidate || typeof source.bytes !== "number" || !Number.isSafeInteger(source.bytes) || source.bytes < 1
    || source.bytes > RUNNABLE_WORLD_SIDECAR_LIMITS.composer_bytes || !sha(source.sha256)) return fail();
  return deepFreeze({ path: candidate, bytes: source.bytes, sha256: source.sha256 as string });
};
const parseProvenance = (value: unknown): RunnableWorldComposerProvenance => {
  const source = exact(value, ["version", "tool", "config", "source_graph", "digest"]);
  const tool = exact(source.tool, ["name", "version", "closure_digest"]); const config = exact(source.config, ["absWorkingDir", "bundle", "charset", "defines", "entryPoint", "external", "format", "legalComments", "metafile", "platform", "sourceSnapshot", "sourcemap", "target", "write"]);
  const defines = exact(config.defines, ["build_receipt_sha256", "config_sha256", "provenance_sha256"]);
  const entryPoint = portable(config.entryPoint);
  if (source.version !== "simfile.world-composer-build.v1" || tool.name !== "esbuild" || !text(tool.version, 64) || !sha(tool.closure_digest)
    || config.absWorkingDir !== "source_root" || config.bundle !== true || config.charset !== "utf8"
    || !entryPoint || entryPoint.length > 512
    || !Array.isArray(config.external) || config.external.length !== 2 || config.external[0] !== "./entrypoint.mjs" || config.external[1] !== "./provider.mjs"
    || config.format !== "esm" || config.legalComments !== "none" || config.platform !== "node"
    || config.metafile !== true || config.sourceSnapshot !== true || config.sourcemap !== false || config.target !== "node22" || config.write !== false
    || !sha(defines.build_receipt_sha256) || !sha(defines.config_sha256) || !sha(defines.provenance_sha256)
    || !Array.isArray(source.source_graph) || source.source_graph.length < 1 || source.source_graph.length > RUNNABLE_WORLD_SIDECAR_LIMITS.source_files) return fail();
  const graph = source.source_graph.map(parseSource);
  if (graph.some((item, index) => index > 0 && compareUtf16(graph[index - 1]!.path, item.path) >= 0)) return fail();
  const unsigned = deepFreeze({ version: "simfile.world-composer-build.v1" as const, tool: { name: "esbuild" as const, version: tool.version as string, closure_digest: tool.closure_digest as string }, config, source_graph: graph });
  const expected = `sha256:${createHash("sha256").update(canonicalJson({ domain: "simfile.world-composer-build.v1", value: unsigned })).digest("hex")}`;
  if (source.digest !== expected) return fail();
  return deepFreeze({ ...unsigned, digest: expected });
};
const parseSecrets = (value: unknown): readonly RunnableWorldSidecarSecret[] => {
  if (!Array.isArray(value) || types.isProxy(value) || value.length < 1 || value.length > 64) return fail();
  const output = value.map((item) => {
    const source = exact(item, ["scope", "name", "principal"]);
    const scope = parseSimfileScopedSecretIdentifier(source.scope);
    const name = parseSimfileScopedSecretIdentifier(source.name);
    const principal = text(source.principal, 256);
    if (!scope || !name || !principal) return fail();
    return deepFreeze({ scope, name, principal });
  });
  if (output.some((item, index) => index > 0 && (compareUtf16(output[index - 1]!.scope, item.scope) > 0
    || (output[index - 1]!.scope === item.scope && compareUtf16(output[index - 1]!.name, item.name) >= 0)))
    || new Set(output.map((item) => item.principal)).size !== output.length) return fail();
  return deepFreeze(output);
};
const parseSecretBinding = (value: unknown): RunnableWorldSidecarManifest["secrets"] => {
  const source = exact(value, ["root", "declarations"]);
  let root: string;
  try { root = parseWorldSidecarAbsolutePath(source.root); } catch { return fail(); }
  return deepFreeze({ root, declarations: parseSecrets(source.declarations) });
};

export const parseRunnableWorldComposerProvenance = (value: unknown): RunnableWorldComposerProvenance => parseProvenance(value);
export const parseRunnableWorldSidecarManifest = (value: unknown): RunnableWorldSidecarManifest => {
  const source = exact(value, ["version", "runtime_abi", "entrypoint", "network", "evidence", "secrets", "artifact", "launcher", "composer", "provider", "digest"]);
  if (source.version !== RUNNABLE_WORLD_SIDECAR_BUNDLE_VERSION || source.runtime_abi !== WORLD_SIDECAR_RUNTIME_ABI || source.entrypoint !== RUNNABLE_WORLD_SIDECAR_ENTRYPOINT) return fail();
  const network = exact(source.network, ["dns_alias", "internal_port"]); const evidence = exact(source.evidence, ["root"]);
  const alias = text(network.dns_alias, 128); let root: string;
  try { root = parseWorldSidecarAbsolutePath(evidence.root); } catch { return fail(); }
  if (!alias || !/^[a-z][a-z0-9-]{0,62}$/u.test(alias) || typeof network.internal_port !== "number"
    || !Number.isSafeInteger(network.internal_port) || network.internal_port < 1 || network.internal_port > 65_535) return fail();
  const artifactSource = exact(source.artifact, ["path", "bytes", "sha256", "service_digest", "manifest", "manifest_file"]);
  const artifactFile = parseFile({ path: artifactSource.path, bytes: artifactSource.bytes, sha256: artifactSource.sha256 }, "world-artifact/entrypoint.mjs", RUNNABLE_WORLD_SIDECAR_LIMITS.artifact_bytes);
  const artifactManifest = parseWorldServiceArtifactManifest(artifactSource.manifest);
  if (artifactSource.service_digest !== artifactManifest.artifact_digest) return fail();
  const manifestFile = parseFile(artifactSource.manifest_file, "world-artifact/manifest.json", RUNNABLE_WORLD_SIDECAR_LIMITS.manifest_bytes);
  const canonicalArtifactManifest = serializeWorldServiceArtifactManifest(artifactManifest);
  if (manifestFile.bytes !== canonicalArtifactManifest.byteLength || manifestFile.sha256 !== rawSha(canonicalArtifactManifest)) return fail();
  const composerSource = exact(source.composer, ["path", "bytes", "sha256", "provenance"]);
  const composerFile = parseFile({ path: composerSource.path, bytes: composerSource.bytes, sha256: composerSource.sha256 }, "world-artifact/composer.mjs", RUNNABLE_WORLD_SIDECAR_LIMITS.composer_bytes);
  const unsigned = {
    version: RUNNABLE_WORLD_SIDECAR_BUNDLE_VERSION, runtime_abi: WORLD_SIDECAR_RUNTIME_ABI, entrypoint: RUNNABLE_WORLD_SIDECAR_ENTRYPOINT,
    network: deepFreeze({ dns_alias: alias, internal_port: network.internal_port }), evidence: deepFreeze({ root }), secrets: parseSecretBinding(source.secrets),
    artifact: deepFreeze({ ...artifactFile, service_digest: artifactManifest.artifact_digest, manifest: artifactManifest, manifest_file: manifestFile }),
    launcher: parseFile(source.launcher, "world-artifact/runner.mjs", RUNNABLE_WORLD_SIDECAR_LIMITS.launcher_bytes),
    composer: deepFreeze({ ...composerFile, provenance: parseProvenance(composerSource.provenance) }),
    provider: parseFile(source.provider, "world-artifact/provider.mjs", RUNNABLE_WORLD_SIDECAR_LIMITS.artifact_bytes),
  };
  if (source.digest !== manifestDigest(unsigned)) return fail();
  return deepFreeze({ ...unsigned, digest: source.digest as string });
};
export const serializeRunnableWorldSidecarManifest = (value: RunnableWorldSidecarManifest): Uint8Array =>
  encoder.encode(`${canonicalJson(parseRunnableWorldSidecarManifest(value))}\n`);

export const redactWorldSidecarError = (value: string): string => value
  .replace(/(bearer|token|secret|password|authorization)\s*[:=]\s*\S+/giu, "$1=[redacted]")
  .replace(/\b[a-f0-9]{32,}\b/giu, (match, offset, whole) => {
    let start = offset;
    while (start > 0 && !/\s/u.test(whole[start - 1])) start -= 1;
    let end = offset + match.length;
    while (end < whole.length && !/\s/u.test(whole[end])) end += 1;
    return whole.slice(start, end).includes("/") ? match : "[redacted]";
  });

const runner = encoder.encode(`import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { startWorldServiceSidecar } from "./entrypoint.mjs";
import * as composer from "./composer.mjs";
const WORLD_SIDECAR_ERROR_OUTPUT_LIMIT = 4000;
const redactWorldSidecarError = ${redactWorldSidecarError.toString()};
const worldSidecarErrorMessage = (error) => {
  if (error instanceof Error && typeof error.message === "string") return redactWorldSidecarError(error.message);
  return redactWorldSidecarError("unexpected non-Error failure");
};
const worldSidecarStartupFailure = (error) => {
  const lines = ["world sidecar startup failed"]; const seen = new Set(); let current = error;
  while (current !== undefined && current !== null && !seen.has(current) && lines.join("\\n").length < WORLD_SIDECAR_ERROR_OUTPUT_LIMIT) {
    seen.add(current); lines.push(\`Caused by: \${worldSidecarErrorMessage(current).slice(0, 512)}\`);
    current = current instanceof Error ? current.cause : undefined;
  }
  return lines.join("\\n").slice(0, WORLD_SIDECAR_ERROR_OUTPUT_LIMIT);
};
const persistWorldSidecarStartupFailure = async (evidenceRoot, failure) => {
  // Stable operator lookup under the manifest evidence root: world-sidecar-startup-failure.log.
  const output = path.join(evidenceRoot, "world-sidecar-startup-failure.log");
  const temporary = \`\${output}.\${process.pid}.\${randomUUID()}.tmp\`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o644);
    await handle.writeFile(\`\${new Date().toISOString()}\\n\${failure}\\n\`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, output);
    const directory = await open(evidenceRoot, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
};
let sidecar; let stopping = false; let exitCode = 0; let evidenceRoot;
const stop = () => { stopping = true; if (sidecar) void sidecar.close().catch(() => { exitCode = 1; }).finally(() => process.exit(exitCode)); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);
try {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const manifest = JSON.parse(await readFile(path.join(root, "..", "bundle.json"), "utf8"));
  evidenceRoot = manifest.evidence?.root;
  sidecar = await startWorldServiceSidecar({ runtime_abi: manifest.runtime_abi, network: manifest.network, evidence_root: evidenceRoot, secret_root: manifest.secrets.root, bearer_declarations: manifest.secrets.declarations, bundle_digest: manifest.digest, activation_bundle_digest: manifest.artifact.service_digest }, composer.composeWorldRuntime, typeof composer.startWorldRuntime === "function" ? composer.startWorldRuntime : undefined, typeof composer.proveWorldRuntimeReadiness === "function" ? composer.proveWorldRuntimeReadiness : undefined, composer.worldRuntimeCapabilities);
  if (stopping) stop();
} catch (error) {
  const failure = worldSidecarStartupFailure(error); console.error(failure);
  if (typeof evidenceRoot === "string") {
    try { await persistWorldSidecarStartupFailure(evidenceRoot, failure); }
    catch { console.error("world sidecar startup failure evidence persistence failed"); }
  }
  process.exitCode = 1;
}
`);
const octal = (value: number, length: number): Uint8Array => encoder.encode(`${value.toString(8).padStart(length - 1, "0")}\0`);
const checkedAdd = (left: number, right: number): number => {
  const value = left + right; if (!Number.isSafeInteger(value) || value > RUNNABLE_WORLD_SIDECAR_LIMITS.archive_bytes) return fail(); return value;
};
const tar = (entries: readonly Readonly<{ path: string; bytes: Uint8Array }>[]): Uint8Array => {
  if (entries.length !== RUNNABLE_WORLD_SIDECAR_ARCHIVE_PATHS.length) return fail();
  const blocks: Uint8Array[] = []; let total = 1024;
  for (const [index, entry] of entries.entries()) {
    if (entry.path !== RUNNABLE_WORLD_SIDECAR_ARCHIVE_PATHS[index]) return fail();
    const header = new Uint8Array(512); const name = encoder.encode(entry.path); if (name.byteLength > 100) return fail();
    header.set(name, 0); header.set(octal(0o644, 8), 100); header.set(octal(0, 8), 108); header.set(octal(0, 8), 116); header.set(octal(entry.bytes.byteLength, 12), 124); header.set(octal(0, 12), 136); header.fill(0x20, 148, 156); header[156] = 0x30; header.set(encoder.encode("ustar\0"), 257); header.set(encoder.encode("00"), 263);
    header.set(octal(header.reduce((sum, byte) => sum + byte, 0), 8), 148);
    const padding = (512 - entry.bytes.byteLength % 512) % 512;
    total = checkedAdd(total, checkedAdd(512, checkedAdd(entry.bytes.byteLength, padding)));
    blocks.push(header, entry.bytes); if (padding) blocks.push(new Uint8Array(padding));
  }
  const output = new Uint8Array(total); let offset = 0;
  for (const block of blocks) { output.set(block, offset); offset = checkedAdd(offset, block.byteLength); }
  return output;
};

/** Produces a bounded deterministic bundle after revalidating every sealed artifact byte. */
export const createRunnableWorldSidecarBundle = async (input: CreateRunnableWorldSidecarBundleInput): Promise<RunnableWorldSidecarBundle> => {
  const source = exact(input, ["artifact", "composer_bytes", "composer_provenance", "provider_bytes", "network", "evidence_root", "secrets"]);
  const artifactEnvelope = exact(source.artifact, ["artifact_bytes", "manifest", "manifest_bytes"]);
  const artifactBytes = exactBytes(artifactEnvelope.artifact_bytes, RUNNABLE_WORLD_SIDECAR_LIMITS.artifact_bytes);
  const artifactManifest = parseWorldServiceArtifactManifest(artifactEnvelope.manifest);
  const artifactManifestBytes = exactBytes(artifactEnvelope.manifest_bytes, RUNNABLE_WORLD_SIDECAR_LIMITS.manifest_bytes);
  const expectedManifestBytes = serializeWorldServiceArtifactManifest(artifactManifest);
  if (rawSha(artifactManifestBytes) !== rawSha(expectedManifestBytes)
    || artifactManifestBytes.length !== expectedManifestBytes.length
    || !artifactManifestBytes.every((byte, index) => byte === expectedManifestBytes[index])
    || domainSha("world-service-artifact.v1", artifactBytes) !== artifactManifest.artifact_digest
    || artifactBytes.byteLength !== artifactManifest.artifact_bytes) return fail();
  if (!(source.composer_bytes instanceof Uint8Array) || types.isProxy(source.composer_bytes)) return fail();
  const composerBytes = new Uint8Array(source.composer_bytes);
  if (composerBytes.byteLength < 1 || composerBytes.byteLength > RUNNABLE_WORLD_SIDECAR_LIMITS.composer_bytes) return fail();
  const provenance = parseProvenance(source.composer_provenance);
  if (!(source.provider_bytes instanceof Uint8Array) || types.isProxy(source.provider_bytes)) return fail();
  const providerBytes = new Uint8Array(source.provider_bytes);
  if (providerBytes.byteLength < 1 || providerBytes.byteLength > RUNNABLE_WORLD_SIDECAR_LIMITS.artifact_bytes) return fail();
  const network = exact(source.network, ["dns_alias", "internal_port"]); const alias = text(network.dns_alias, 128);
  let evidenceRoot: string; try { evidenceRoot = parseWorldSidecarAbsolutePath(source.evidence_root); } catch { return fail(); }
  if (!alias || !/^[a-z][a-z0-9-]{0,62}$/u.test(alias) || typeof network.internal_port !== "number"
    || !Number.isSafeInteger(network.internal_port) || network.internal_port < 1 || network.internal_port > 65_535) return fail();
  const unsigned = {
    version: RUNNABLE_WORLD_SIDECAR_BUNDLE_VERSION, runtime_abi: WORLD_SIDECAR_RUNTIME_ABI, entrypoint: RUNNABLE_WORLD_SIDECAR_ENTRYPOINT,
    network: deepFreeze({ dns_alias: alias, internal_port: network.internal_port }), evidence: deepFreeze({ root: evidenceRoot }), secrets: parseSecretBinding(source.secrets),
    artifact: deepFreeze({ path: "world-artifact/entrypoint.mjs", bytes: artifactBytes.byteLength, sha256: rawSha(artifactBytes), service_digest: artifactManifest.artifact_digest, manifest: artifactManifest,
      manifest_file: { path: "world-artifact/manifest.json", bytes: artifactManifestBytes.byteLength, sha256: rawSha(artifactManifestBytes) } }),
    launcher: deepFreeze({ path: "world-artifact/runner.mjs", bytes: runner.byteLength, sha256: rawSha(runner) }),
    composer: deepFreeze({ path: "world-artifact/composer.mjs", bytes: composerBytes.byteLength, sha256: rawSha(composerBytes), provenance }),
    provider: deepFreeze({ path: "world-artifact/provider.mjs", bytes: providerBytes.byteLength, sha256: rawSha(providerBytes) }),
  };
  const manifest = parseRunnableWorldSidecarManifest({ ...unsigned, digest: manifestDigest(unsigned) });
  const manifestBytes = serializeRunnableWorldSidecarManifest(manifest);
  if (manifestBytes.byteLength > RUNNABLE_WORLD_SIDECAR_LIMITS.manifest_bytes) return fail();
  const archive = tar([
    { path: "bundle.json", bytes: manifestBytes }, { path: "world-artifact/composer.mjs", bytes: composerBytes },
    { path: "world-artifact/entrypoint.mjs", bytes: artifactBytes },
    { path: "world-artifact/manifest.json", bytes: artifactManifestBytes },
    { path: "world-artifact/provider.mjs", bytes: providerBytes },
    { path: "world-artifact/runner.mjs", bytes: runner },
  ]);
  return deepFreeze({ archive_bytes: Object.freeze(Array.from(archive)), archive_sha256: rawSha(archive), manifest, manifest_bytes: Object.freeze(Array.from(manifestBytes)) });
};
