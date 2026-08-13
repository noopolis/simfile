import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { parseRunManifest } from "../observe/manifest.js";

const SAFE_ID = /^[a-z][a-z0-9-]{0,63}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const safeArtifactPath = (value: string): boolean => {
  if (value.length === 0 || value.includes("\\") || value.includes("\0")) return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  return !value.split("/").includes("..");
};

const inside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === ""
    || !(relative === ".." || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative));
};

const readBoundPayload = async (
  root: string,
  relative: string,
  expectedSha256: string,
): Promise<unknown> => {
  const artifact = await realpath(path.join(root, ...relative.split("/")));
  if (!inside(root, artifact)) {
    throw new Error(`viewer extension data escapes the run directory: ${relative}`);
  }
  const bytes = await readFile(artifact);
  if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
    throw new Error(`viewer extension data integrity failed: ${relative}`);
  }
  return JSON.parse(bytes.toString("utf8")) as unknown;
};

/**
 * Loads optional, opaque extension-owned presentation data from a sealed run.
 * The generic viewer knows only extension ids, manifest artifact paths, and
 * hashes. It never interprets a scenario's payload.
 */
export const readRunViewerExtensionData = async (
  runDir: string,
): Promise<Readonly<Record<string, unknown>> | undefined> => {
  const root = await realpath(path.resolve(runDir));
  const manifest = parseRunManifest(JSON.parse(
    await readFile(path.join(root, "manifest.json"), "utf8"),
  ));
  const declaration = manifest.world?.viewer_extension_data;
  if (declaration === undefined) return undefined;
  if (!isRecord(declaration)) {
    throw new TypeError("manifest world.viewer_extension_data must be an object");
  }
  const artifacts = new Map(manifest.artifacts.map((artifact) => [artifact.path, artifact.sha256]));
  const loaded: Record<string, unknown> = {};
  for (const [extensionId, relative] of Object.entries(declaration)) {
    if (!SAFE_ID.test(extensionId) || typeof relative !== "string"
      || !safeArtifactPath(relative) || !artifacts.has(relative)) {
      throw new TypeError("invalid manifest world.viewer_extension_data entry");
    }
    loaded[extensionId] = await readBoundPayload(
      root,
      relative,
      artifacts.get(relative)!,
    );
  }
  return Object.freeze(loaded);
};

/** Reads the producer-written, hash-bound opaque payload while a run is open. */
export const readStagingViewerExtensionData = async (
  stagingDir: string,
): Promise<Readonly<Record<string, unknown>> | undefined> => {
  let raw: unknown;
  let root: string;
  try {
    root = await realpath(path.resolve(stagingDir));
    raw = JSON.parse(await readFile(
      path.join(root, "viewer-extension-data.json"),
      "utf8",
    )) as unknown;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  if (!isRecord(raw)
    || raw.version !== "simfile.viewer-extension-data.v1"
    || !Array.isArray(raw.extensions)
    || Object.keys(raw).sort().join(",") !== "extensions,version") {
    throw new TypeError("invalid staging viewer extension data declaration");
  }
  const loaded: Record<string, unknown> = {};
  try {
    for (const entry of raw.extensions) {
      if (!isRecord(entry)
        || Object.keys(entry).sort().join(",") !== "id,path,sha256"
        || typeof entry.id !== "string" || !SAFE_ID.test(entry.id)
        || entry.id in loaded
        || typeof entry.path !== "string" || !safeArtifactPath(entry.path)
        || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
        throw new TypeError("invalid staging viewer extension data entry");
      }
      loaded[entry.id] = await readBoundPayload(root, entry.path, entry.sha256);
    }
  } catch (error) {
    // A reader can hold the old declaration while seal removes its referenced
    // generation. That exact ENOENT is an absent live generation, not a server
    // failure; all other validation and integrity errors remain fatal.
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  return Object.freeze(loaded);
};
