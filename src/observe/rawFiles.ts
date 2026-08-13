import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { parseRunManifest } from "./manifest.js";

/** One raw artifact together with both of the paths its consumers need. */
export interface RunRawFile {
  /** Absolute filesystem path used only for the read. */
  absolutePath: string;
  /** Actual path relative to the sealed run directory. */
  relativePath: string;
  /** Path beginning at the artifact namespace's `raw/` directory. */
  rawRelativePath: string;
}

const walkFiles = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
};

const manifestRelativePath = (value: string): string | undefined => {
  if (value.includes("\\") || value.includes("\0")
    || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return undefined;
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return undefined;
  }
  return segments.join(path.sep);
};

const rawRelativePath = (relativePath: string): string | undefined => {
  const segments = relativePath.split(path.sep);
  const rawIndex = segments.indexOf("raw");
  return rawIndex < 0 ? undefined : segments.slice(rawIndex).join(path.sep);
};

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null
  && (error as { code?: unknown }).code === "ENOENT";

const isInside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || !(relative === ".." || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative));
};

const compareLexically = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Finds raw evidence in both supported sealed layouts without knowing any
 * scenario vocabulary:
 *
 * - the historical top-level `raw/**` tree remains discoverable as before;
 * - a nested raw namespace is admitted only when the run manifest names the
 *   exact file (composed records currently use `organization/raw/**`).
 *
 * The returned `relativePath` never hides the namespace. Consumers use
 * `rawRelativePath` only to identify the authority immediately below `raw/`.
 */
export const findRunRawFiles = async (runDir: string): Promise<RunRawFile[]> => {
  const root = path.resolve(runDir);
  const files = new Map<string, RunRawFile>();
  const byRawRelative = new Map<string, string>();
  const add = (file: RunRawFile): void => {
    const prior = byRawRelative.get(file.rawRelativePath);
    if (prior !== undefined && prior !== file.relativePath) {
      throw new TypeError(
        `ambiguous raw artifact ${file.rawRelativePath}: ${prior}, ${file.relativePath}`,
      );
    }
    byRawRelative.set(file.rawRelativePath, file.relativePath);
    files.set(file.relativePath, file);
  };

  for (const absolutePath of await walkFiles(path.join(root, "raw"))) {
    const relativePath = path.relative(root, absolutePath);
    const rawRelative = rawRelativePath(relativePath);
    if (rawRelative !== undefined) {
      add({ absolutePath, relativePath, rawRelativePath: rawRelative });
    }
  }

  const manifestText = await readFile(path.join(root, "manifest.json"), "utf8")
    .catch((error: unknown) => {
      if (isMissing(error)) return null;
      throw error;
    });
  if (manifestText === null) {
    return [...files.values()].sort((left, right) =>
      compareLexically(left.relativePath, right.relativePath));
  }
  const manifest = parseRunManifest(JSON.parse(manifestText) as unknown);
  const nestedPaths = new Set<string>();
  const realRoot = await realpath(root);
  for (const artifact of manifest.artifacts) {
    const relativePath = manifestRelativePath(artifact.path);
    if (relativePath === undefined || relativePath.startsWith(`raw${path.sep}`)) continue;
    const rawRelative = rawRelativePath(relativePath);
    if (rawRelative === undefined || rawRelative === "raw") continue;
    if (nestedPaths.has(relativePath)) {
      throw new TypeError(`nested raw artifact is listed more than once: ${artifact.path}`);
    }
    nestedPaths.add(relativePath);
    const absolutePath = await realpath(path.resolve(root, relativePath))
      .catch((error: unknown) => {
        if (isMissing(error)) return null;
        throw error;
      });
    // Artifact integrity reports manifest entries whose bytes are absent.
    // Readers omit those entries rather than turning a diagnostic view into
    // a second, less-informative missing-file failure.
    if (absolutePath === null) continue;
    if (!isInside(realRoot, absolutePath)) {
      throw new TypeError(`nested raw artifact escapes the run directory: ${artifact.path}`);
    }
    add({ absolutePath, relativePath, rawRelativePath: rawRelative });
  }

  return [...files.values()].sort((left, right) =>
    compareLexically(left.relativePath, right.relativePath));
};

/** The authority directly below a raw namespace, never the namespace itself. */
export const rawAuthority = (rawRelative: string): string =>
  (() => {
    const segments = rawRelative.split(path.sep);
    const rawIndex = segments.indexOf("raw");
    return rawIndex < 0 ? "unknown" : segments[rawIndex + 1] ?? "unknown";
  })();

/** The bank name for `raw/mneme/<bank>/...`, if this is a bank artifact. */
export const rawBank = (rawRelative: string): string | undefined => {
  const segments = rawRelative.split(path.sep);
  const rawIndex = segments.indexOf("raw");
  return rawIndex >= 0 && segments[rawIndex + 1] === "mneme"
    ? segments[rawIndex + 2]
    : undefined;
};
