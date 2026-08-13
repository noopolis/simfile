import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { parseRunManifest } from "../observe/manifest.js";
import type { RunWorldTrace } from "./runWorldTrace.js";

const TRACE_ARRAY_FIELDS = [
  "rooms",
  "corridors",
  "agents",
  "presence",
  "ledger_facts",
  "signals",
  "spatial_samples",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const finitePair = (value: unknown): boolean =>
  Array.isArray(value) && value.length === 2
  && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
const stringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const validateSpatialSamples = (samples: readonly unknown[]): void => {
  const ticks = new Set<number>();
  for (const sample of samples) {
    if (!isRecord(sample) || !Number.isSafeInteger(sample.tick)
      || (sample.tick as number) < 0 || ticks.has(sample.tick as number)
      || !isRecord(sample.occupancy) || !Array.isArray(sample.transit)
      || (sample.discontinuities !== undefined && !stringArray(sample.discontinuities))
      || Object.values(sample.occupancy).some((members) => !stringArray(members))) {
      throw new TypeError("invalid viewer projection spatial sample");
    }
    ticks.add(sample.tick as number);
    if (sample.objects !== undefined) {
      if (!Array.isArray(sample.objects)) {
        throw new TypeError("invalid viewer projection spatial objects");
      }
      const ids = new Set<string>();
      for (const object of sample.objects) {
        if (!isRecord(object) || typeof object.id !== "string" || object.id.length === 0
          || ids.has(object.id) || !finitePair(object.position)
          || (object.velocity !== undefined && !finitePair(object.velocity))) {
          throw new TypeError("invalid viewer projection spatial object");
        }
        ids.add(object.id);
      }
    }
    for (const transit of sample.transit) {
      const remaining = isRecord(transit) ? transit.ticks_remaining : undefined;
      if (!isRecord(transit) || typeof transit.agent !== "string"
        || typeof transit.from_room !== "string" || typeof transit.path_id !== "string"
        || !Number.isSafeInteger(remaining) || (remaining as number) < 0
        || typeof transit.to_room !== "string") {
        throw new TypeError("invalid viewer projection transit");
      }
    }
  }
};

const safeArtifactPath = (value: string): boolean => {
  if (value.length === 0 || value.includes("\\") || value.includes("\0")) {
    return false;
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  return value.split("/").every((part) =>
    part.length > 0 && part !== "." && part !== "..");
};

const inside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === ""
    || !(relative === ".." || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative));
};

const parseProjection = (
  raw: unknown,
  runId: string,
): RunWorldTrace => {
  if (!isRecord(raw)
    || raw.version !== "viewer.trace.v1"
    || raw.run_id !== runId
    || typeof raw.run_name !== "string"
    || TRACE_ARRAY_FIELDS.some((field) => !Array.isArray(raw[field]))) {
    throw new TypeError(
      "invalid viewer projection: expected viewer.trace.v1 with matching run_id and trace arrays",
    );
  }
  if (raw.tick_duration_ms !== undefined
    && (typeof raw.tick_duration_ms !== "number"
      || !Number.isFinite(raw.tick_duration_ms)
      || raw.tick_duration_ms <= 0)) {
    throw new TypeError("invalid viewer projection tick_duration_ms");
  }
  if (raw.playback_status !== undefined
    && (typeof raw.playback_status !== "string"
      || !["live", "completed", "failed"].includes(raw.playback_status))) {
    throw new TypeError("invalid viewer projection playback_status");
  }
  validateSpatialSamples(raw.spatial_samples as unknown[]);
  return Object.freeze(raw) as unknown as RunWorldTrace;
};

/**
 * Loads a sealed producer-authored generic viewer trace. The manifest is the
 * sole path authority: an unlisted, escaping, or hash-mismatched file never
 * becomes viewer state.
 */
export const readRunViewerProjection = async (
  runDir: string,
): Promise<RunWorldTrace | undefined> => {
  const root = await realpath(path.resolve(runDir));
  const manifest = parseRunManifest(JSON.parse(
    await readFile(path.join(root, "manifest.json"), "utf8"),
  ));
  const relative = manifest.world?.viewer_projection;
  if (relative === undefined) return undefined;
  if (typeof relative !== "string" || !safeArtifactPath(relative)) {
    throw new TypeError(
      "manifest world.viewer_projection must be a safe relative artifact path",
    );
  }
  const entries = manifest.artifacts.filter((artifact) =>
    artifact.path === relative);
  if (entries.length !== 1) {
    throw new TypeError(
      "manifest world.viewer_projection must name exactly one listed artifact",
    );
  }
  const artifactPath = await realpath(path.join(root, ...relative.split("/")));
  if (!inside(root, artifactPath)) {
    throw new Error(`viewer projection escapes the run directory: ${relative}`);
  }
  const bytes = await readFile(artifactPath);
  if (createHash("sha256").update(bytes).digest("hex") !== entries[0]!.sha256) {
    throw new Error(`viewer projection integrity failed: ${relative}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new TypeError(`invalid viewer projection JSON: ${relative}`);
  }
  return parseProjection(raw, manifest.run_id);
};
