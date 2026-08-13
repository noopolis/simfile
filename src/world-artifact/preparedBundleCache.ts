import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from "../dynamics/buildIdentity.js";
import {
  parseRunnableWorldSidecarManifest,
  RUNNABLE_WORLD_SIDECAR_ARCHIVE_PATHS,
  serializeRunnableWorldSidecarManifest,
  type RunnableWorldSidecarBundle,
} from "./runnableBundle.js";

export const PREPARED_WORLD_SIDECAR_CACHE_VERSION =
  "simfile.prepared-world-sidecar-cache.v1" as const;

export interface PreparedWorldSidecarInputPath {
  readonly absolute_path: string;
  readonly label: string;
  readonly kind?: "tree" | "source-directory";
  readonly excluded_names?: readonly string[];
}

export interface CreatePreparedWorldSidecarInputDigestInput {
  readonly identity: unknown;
  readonly inputs: readonly PreparedWorldSidecarInputPath[];
}

export interface PreparedWorldSidecarCacheResult {
  readonly bundle: RunnableWorldSidecarBundle;
  readonly cache: Readonly<{
    readonly input_digest: string;
    readonly identity_ms: number;
    readonly lookup_ms: number;
    readonly path: string;
    readonly reason: string;
    readonly status: "hit" | "miss";
  }>;
}

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const digest = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const hashTree = async (
  hash: ReturnType<typeof createHash>,
  absolute: string,
  label: string,
  excludedNames: ReadonlySet<string>,
): Promise<void> => {
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink()) {
    throw new TypeError(`prepared world cache input is symlinked: ${label}`);
  }
  if (stat.isFile()) {
    const bytes = await readFile(absolute);
    hash.update(`file\0${label}\0${stat.mode & 0o111}\0${bytes.byteLength}\0`);
    hash.update(bytes);
    return;
  }
  if (!stat.isDirectory()) throw new TypeError("prepared world input is not portable");
  hash.update(`directory\0${label}\0`);
  const entries = await readdir(absolute, { withFileTypes: true });
  entries.sort((left, right) => compare(left.name, right.name));
  for (const entry of entries) {
    if (excludedNames.has(entry.name)) continue;
    await hashTree(
      hash,
      path.join(absolute, entry.name),
      `${label}/${entry.name}`,
      excludedNames,
    );
  }
};

const hashSourceDirectory = async (
  hash: ReturnType<typeof createHash>,
  input: PreparedWorldSidecarInputPath,
): Promise<void> => {
  const rootStat = await lstat(input.absolute_path);
  if (rootStat.isSymbolicLink()) {
    throw new TypeError(`prepared world cache input is symlinked: ${input.label}`);
  }
  if (!rootStat.isDirectory()) {
    throw new TypeError("prepared world source-directory input is invalid");
  }
  const excluded = new Set(input.excluded_names ?? []);
  const allEntries = await readdir(input.absolute_path, { withFileTypes: true });
  if (allEntries.some((entry) => entry.isSymbolicLink() && !excluded.has(entry.name))) {
    throw new TypeError(`prepared world cache input is symlinked: ${input.label}`);
  }
  const entries = allEntries
    .filter((entry) => entry.isFile()
      && !entry.name.endsWith(".test.ts")
      && /\.(?:[cm]?[jt]s|tsx)$/u.test(entry.name)
      && !excluded.has(entry.name))
    .sort((left, right) => compare(left.name, right.name));
  hash.update(`source-directory\0${input.label}\0`);
  for (const entry of entries) {
    await hashTree(
      hash,
      path.join(input.absolute_path, entry.name),
      `${input.label}/${entry.name}`,
      new Set(),
    );
  }
};

/** Hashes declared source/tool/config inputs without following symlinks. */
export const createPreparedWorldSidecarInputDigest = async (
  input: CreatePreparedWorldSidecarInputDigestInput,
): Promise<string> => {
  const hash = createHash("sha256");
  hash.update(`${PREPARED_WORLD_SIDECAR_CACHE_VERSION}\0`);
  hash.update(canonicalJson(input.identity));
  const inputs = [...input.inputs].sort((left, right) => compare(left.label, right.label));
  if (inputs.length < 1
    || inputs.some((item, index) => index > 0 && item.label === inputs[index - 1]!.label)) {
    throw new TypeError("prepared world input declarations are not unique");
  }
  for (const item of inputs) {
    if (!path.isAbsolute(item.absolute_path) || item.label.length < 1
      || item.label !== item.label.trim()
      || !/^[A-Za-z0-9@][A-Za-z0-9@._/-]*$/u.test(item.label)
      || (item.excluded_names ?? []).some((name) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name))) {
      throw new TypeError("prepared world input declaration is invalid");
    }
    const normalized = { ...item, absolute_path: path.resolve(item.absolute_path) };
    if (item.kind === "source-directory") await hashSourceDirectory(hash, normalized);
    else await hashTree(
      hash,
      normalized.absolute_path,
      normalized.label,
      new Set(normalized.excluded_names ?? []),
    );
  }
  return `sha256:${hash.digest("hex")}`;
};

const exactRecord = (raw: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype
    || Object.keys(raw).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new TypeError("cache schema mismatch");
  }
  return raw as Record<string, unknown>;
};

const archiveEntries = (archive: Uint8Array): ReadonlyMap<string, Uint8Array> => {
  const output = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + 512 <= archive.byteLength && archive[offset] !== 0) {
    const header = archive.subarray(offset, offset + 512);
    const nameEnd = header.indexOf(0);
    if (nameEnd < 1) throw new TypeError("cache archive is invalid");
    const name = new TextDecoder().decode(header.subarray(0, nameEnd));
    const size = Number.parseInt(new TextDecoder().decode(header.subarray(124, 136))
      .replace(/\0.*$/u, "").trim(), 8);
    if (!RUNNABLE_WORLD_SIDECAR_ARCHIVE_PATHS.includes(
      name as typeof RUNNABLE_WORLD_SIDECAR_ARCHIVE_PATHS[number],
    ) || output.has(name) || header[156] !== 0x30
      || !Number.isSafeInteger(size) || size < 1
      || offset + 512 + size > archive.byteLength) {
      throw new TypeError("cache archive is invalid");
    }
    output.set(name, archive.slice(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (output.size !== RUNNABLE_WORLD_SIDECAR_ARCHIVE_PATHS.length
    || RUNNABLE_WORLD_SIDECAR_ARCHIVE_PATHS.some((name) => !output.has(name))
    || offset + 1024 !== archive.byteLength) {
    throw new TypeError("cache archive is incomplete");
  }
  return output;
};

const parseCacheEntry = (raw: unknown, inputDigest: string): RunnableWorldSidecarBundle => {
  const entry = exactRecord(raw, [
    "archive_base64", "archive_sha256", "input_digest", "manifest",
    "manifest_base64", "version",
  ]);
  if (entry.version !== PREPARED_WORLD_SIDECAR_CACHE_VERSION
    || entry.input_digest !== inputDigest
    || typeof entry.archive_base64 !== "string"
    || typeof entry.manifest_base64 !== "string"
    || typeof entry.archive_sha256 !== "string"
    || !digestPattern.test(entry.archive_sha256)) {
    throw new TypeError("cache schema mismatch");
  }
  const archive = Buffer.from(entry.archive_base64, "base64");
  const manifestBytes = Buffer.from(entry.manifest_base64, "base64");
  if (archive.toString("base64") !== entry.archive_base64
    || manifestBytes.toString("base64") !== entry.manifest_base64
    || digest(archive) !== entry.archive_sha256) {
    throw new TypeError("cache digest mismatch");
  }
  const manifest = parseRunnableWorldSidecarManifest(entry.manifest);
  const canonicalManifest = serializeRunnableWorldSidecarManifest(manifest);
  if (!manifestBytes.equals(canonicalManifest)) throw new TypeError("cache manifest mismatch");
  const files = archiveEntries(archive);
  const expected = new Map<string, string>([
    ["bundle.json", digest(canonicalManifest)],
    [manifest.composer.path, manifest.composer.sha256],
    [manifest.artifact.path, manifest.artifact.sha256],
    [manifest.artifact.manifest_file.path, manifest.artifact.manifest_file.sha256],
    [manifest.provider.path, manifest.provider.sha256],
    [manifest.launcher.path, manifest.launcher.sha256],
  ]);
  for (const [name, expectedDigest] of expected) {
    if (digest(files.get(name)!) !== expectedDigest) {
      throw new TypeError("cache archive digest mismatch");
    }
  }
  return Object.freeze({
    archive_bytes: Object.freeze(Array.from(archive)),
    archive_sha256: entry.archive_sha256,
    manifest,
    manifest_bytes: Object.freeze(Array.from(manifestBytes)),
  });
};

const cacheEntry = (bundle: RunnableWorldSidecarBundle, inputDigest: string): string =>
  `${canonicalJson({
    archive_base64: Buffer.from(bundle.archive_bytes).toString("base64"),
    archive_sha256: bundle.archive_sha256,
    input_digest: inputDigest,
    manifest: bundle.manifest,
    manifest_base64: Buffer.from(bundle.manifest_bytes).toString("base64"),
    version: PREPARED_WORLD_SIDECAR_CACHE_VERSION,
  })}\n`;

/** Loads only a fully revalidated bundle, or atomically publishes one exact build. */
export const loadOrCreatePreparedWorldSidecarBundle = async (input: Readonly<{
  readonly cache_root: string;
  readonly input_digest: string;
  readonly build: () => Promise<RunnableWorldSidecarBundle>;
}>): Promise<PreparedWorldSidecarCacheResult> => {
  const identityStartedAt = performance.now();
  if (!digestPattern.test(input.input_digest)) {
    throw new TypeError("prepared world cache input digest is invalid");
  }
  const identityMs = Math.round(performance.now() - identityStartedAt);
  const root = path.resolve(input.cache_root);
  if (!path.isAbsolute(input.cache_root) || root !== input.cache_root
    || root === path.parse(root).root) {
    throw new TypeError("prepared world cache root is invalid");
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const file = path.join(root, `${input.input_digest.slice("sha256:".length)}.json`);
  const lookupStartedAt = performance.now();
  try {
    const bundle = parseCacheEntry(JSON.parse(await readFile(file, "utf8")), input.input_digest);
    return Object.freeze({
      bundle,
      cache: Object.freeze({ input_digest: input.input_digest, identity_ms: identityMs,
        lookup_ms: Math.round(performance.now() - lookupStartedAt), path: file,
        reason: "validated", status: "hit" as const }),
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const reason = error instanceof Error
        ? error.message.replace(/[^a-z0-9 _-]/giu, "").slice(0, 80)
        : "cache validation failed";
      throw new Error(`prepared world sidecar cache rejected: ${reason}`, { cause: error });
    }
  }
  const bundle = await input.build();
  const temporary = `${file}.${process.pid}.${randomUUID()}.pending`;
  await writeFile(temporary, cacheEntry(bundle, input.input_digest), {
    encoding: "utf8", flag: "wx", mode: 0o600,
  });
  let reason = "input_digest_not_found";
  try {
    await link(temporary, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    reason = "concurrent_writer_validated";
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  const validated = parseCacheEntry(
    JSON.parse(await readFile(file, "utf8")),
    input.input_digest,
  );
  if (validated.archive_sha256 !== bundle.archive_sha256
    || validated.manifest.digest !== bundle.manifest.digest) {
    throw new Error("prepared world sidecar cache rejected: concurrent writer drift");
  }
  return Object.freeze({
    bundle: validated,
    cache: Object.freeze({ input_digest: input.input_digest, identity_ms: identityMs,
      lookup_ms: Math.round(performance.now() - lookupStartedAt), path: file,
      reason, status: "miss" as const }),
  });
};
