import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { parseRunManifest } from "../observe/manifest.js";
import {
  NO_PLACE_CAPTION,
  type RunWorldTrace,
  type RunWorldTraceAgent,
  type RunWorldTraceRoom,
  type RunWorldTraceSpatialSample,
} from "./runWorldTrace.js";

/**
 * Reads the dynamics run record's motion track (`raw/frames.jsonl`) and
 * projects it into the `viewer.trace.v1` fields the React client already
 * animates. No new viewer contract: `spatial_samples[].objects[]` is the
 * existing genre-neutral carrier, so the renderer needs no genre knowledge
 * and no changes.
 *
 * TORN LAST LINE IS NORMAL ONLY BEFORE SEAL. An open producer can expose a
 * valid prefix with an incomplete final line. Once `manifest.json` exists,
 * this reader requires its listed hash and a complete parse.
 */

export const DYNAMICS_RUN_FRAMES_HEADER_VERSION = "simfile.dynamics-run-frames-header.v1";
export const DYNAMICS_RUN_FRAME_VERSION = "simfile.dynamics-run-frame.v1";

export interface RunFrameTrack {
  bounds?: { max: [number, number]; min: [number, number] };
  samples: RunWorldTraceSpatialSample[];
  /** Milliseconds of simulated time per tick, for the viewer's interpolation clock. */
  tickDurationMs: number;
  simSecondsPerTick?: number;
  timing?: RunFrameTiming[];
}

export interface RunFrameTiming {
  tick: number;
  wallElapsedSeconds: number;
  simSecondsAdvanced: number;
}

export interface RunFramesFrom {
  header?: Record<string, unknown>;
  samples: RunWorldTraceSpatialSample[];
  timing: RunFrameTiming[];
  nextOffsetBytes: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isMissing = (error: unknown): boolean =>
  isRecord(error) && error.code === "ENOENT";
const inside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === ""
    || !(relative === ".." || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative));
};

const pair = (value: unknown): [number, number] | undefined =>
  Array.isArray(value) && value.length === 2
    && typeof value[0] === "number" && Number.isFinite(value[0])
    && typeof value[1] === "number" && Number.isFinite(value[1])
    ? [value[0], value[1]]
    : undefined;
const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value] : undefined;
const occupancy = (value: unknown): Record<string, string[]> | undefined => {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).map(([room, members]) => [room, strings(members)] as const);
  return entries.some(([, members]) => members === undefined)
    ? undefined
    : Object.fromEntries(entries) as Record<string, string[]>;
};
const transit = (value: unknown): RunWorldTraceSpatialSample["transit"] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const entries: RunWorldTraceSpatialSample["transit"] = [];
  for (const entry of value) {
    const ticksRemaining = isRecord(entry) ? entry.ticks_remaining : undefined;
    if (!isRecord(entry) || typeof entry.agent !== "string"
      || typeof entry.from_room !== "string" || typeof entry.path_id !== "string"
      || !Number.isSafeInteger(ticksRemaining) || (ticksRemaining as number) < 0
      || typeof entry.to_room !== "string") return undefined;
    entries.push({ agent: entry.agent, from_room: entry.from_room,
      path_id: entry.path_id, ticks_remaining: ticksRemaining as number,
      to_room: entry.to_room });
  }
  return entries;
};

const parseSample = (value: unknown): RunWorldTraceSpatialSample | undefined => {
  if (!isRecord(value) || value.version !== DYNAMICS_RUN_FRAME_VERSION) return undefined;
  if (typeof value.tick !== "number" || !Number.isInteger(value.tick)) return undefined;
  if (value.objects !== undefined && !Array.isArray(value.objects)) return undefined;
  const sampleOccupancy = value.occupancy === undefined ? {} : occupancy(value.occupancy);
  const sampleTransit = value.transit === undefined ? [] : transit(value.transit);
  const discontinuities = value.discontinuities === undefined
    ? undefined : strings(value.discontinuities);
  if (sampleOccupancy === undefined || sampleTransit === undefined
    || (value.discontinuities !== undefined && discontinuities === undefined)) return undefined;
  const objects = [];
  for (const entry of value.objects ?? []) {
    if (!isRecord(entry) || typeof entry.id !== "string") return undefined;
    const position = pair(entry.position);
    const velocity = pair(entry.velocity);
    if (position === undefined || velocity === undefined) return undefined;
    objects.push({ id: entry.id, position, velocity });
  }
  // Generic composed projections may carry both continuous positions and
  // room/transit evidence; ordinary dynamics tracks default those fields.
  return { ...(discontinuities === undefined ? {} : { discontinuities }),
    objects, occupancy: sampleOccupancy, tick: value.tick, transit: sampleTransit };
};

const parseFrames = (bytes: Buffer, offsetBytes: number): RunFramesFrom => {
  const start = Math.max(0, Math.min(offsetBytes, bytes.length));
  const text = bytes.subarray(start).toString("utf8");
  let header: Record<string, unknown> | undefined;
  const samples: RunWorldTraceSpatialSample[] = [];
  const timing: RunFrameTiming[] = [];
  let cursor = 0;
  const readHeader = start === 0;
  while (cursor < text.length) {
    const newline = text.indexOf("\n", cursor);
    const end = newline < 0 ? text.length : newline;
    const line = text.slice(cursor, end);
    if (line.trim().length === 0) {
      cursor = newline < 0 ? end : end + 1;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      break;
    }
    if (readHeader && header === undefined) {
      if (!isRecord(parsed) || parsed.version !== DYNAMICS_RUN_FRAMES_HEADER_VERSION) {
        return { samples: [], timing: [], nextOffsetBytes: start };
      }
      header = parsed;
    } else {
      const sample = parseSample(parsed);
      if (sample === undefined) break;
      if ((parsed as Record<string, unknown>).objects !== undefined) samples.push(sample);
      const frameRecord = parsed as Record<string, unknown>;
      if (typeof frameRecord.wall_elapsed_seconds === "number"
        && Number.isFinite(frameRecord.wall_elapsed_seconds)
        && typeof frameRecord.sim_seconds_advanced === "number"
        && Number.isFinite(frameRecord.sim_seconds_advanced)) {
        timing.push({
          tick: sample.tick,
          wallElapsedSeconds: frameRecord.wall_elapsed_seconds,
          simSecondsAdvanced: frameRecord.sim_seconds_advanced,
        });
      }
    }
    cursor = newline < 0 ? end : end + 1;
  }
  const consumed = Buffer.byteLength(text.slice(0, cursor), "utf8");
  return { header, samples, timing, nextOffsetBytes: start + consumed };
};

const trackFromHeader = (
  header: Record<string, unknown>,
  samples: RunWorldTraceSpatialSample[],
  timing: RunFrameTiming[],
): RunFrameTrack => {

  const dt = header.sim_seconds_per_tick;
  const bounds = isRecord(header.bounds)
    ? (() => {
      const max = pair(header.bounds.max);
      const min = pair(header.bounds.min);
      return max && min ? { max, min } : undefined;
    })()
    : undefined;

  return {
    ...(bounds ? { bounds } : {}),
    samples,
    ...(typeof dt === "number" && Number.isFinite(dt) && dt > 0 ? { simSecondsPerTick: dt } : {}),
    timing,
    // The viewer multiplies velocity by a duration derived from this, so it
    // must be the run's real tick duration, never the client's 20ms default.
    tickDurationMs: typeof dt === "number" && Number.isFinite(dt) && dt > 0 ? dt * 1_000 : 20
  };
};

const readRunFrameBytes = async (runDir: string): Promise<Readonly<{
  bytes: Buffer;
  sealed: boolean;
}> | null> => {
  const framesPath = path.join(runDir, "raw", "frames.jsonl");
  let manifestText: string;
  try {
    manifestText = await readFile(path.join(runDir, "manifest.json"), "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
    const bytes = await readFile(framesPath).catch((framesError: unknown) => {
      if (isMissing(framesError)) return null;
      throw framesError;
    });
    return bytes === null ? null : { bytes, sealed: false };
  }
  const manifest = parseRunManifest(JSON.parse(manifestText) as unknown);
  const entries = manifest.artifacts.filter(({ path: artifactPath }) =>
    artifactPath === "raw/frames.jsonl");
  if (entries.length === 0) return null;
  if (entries.length !== 1) {
    throw new TypeError("sealed run must list raw/frames.jsonl exactly once");
  }
  const [root, resolvedFrames] = await Promise.all([
    realpath(path.resolve(runDir)),
    realpath(framesPath),
  ]);
  if (!inside(root, resolvedFrames)) {
    throw new Error("sealed raw/frames.jsonl escapes the run directory");
  }
  const bytes = await readFile(resolvedFrames);
  if (createHash("sha256").update(bytes).digest("hex") !== entries[0]!.sha256) {
    throw new Error("sealed raw/frames.jsonl integrity failed");
  }
  return { bytes, sealed: true };
};

export const readRunFrames = async (runDir: string): Promise<RunFrameTrack | undefined> => {
  const source = await readRunFrameBytes(runDir);
  if (source === null) return undefined;
  if (source.bytes.byteLength === 0) return undefined;
  const parsed = parseFrames(source.bytes, 0);
  if (source.sealed && (parsed.header === undefined
    || parsed.nextOffsetBytes !== source.bytes.byteLength)) {
    throw new TypeError("sealed raw/frames.jsonl is not a complete frame track");
  }
  if (parsed.header === undefined) return undefined;
  return trackFromHeader(parsed.header, parsed.samples, parsed.timing);
};

export const readRunFramesFrom = async (
  framesPath: string,
  offsetBytes: number,
): Promise<RunFramesFrom> => {
  const bytes = await readFile(framesPath).catch(() => null);
  if (bytes === null) return { samples: [], timing: [], nextOffsetBytes: offsetBytes };
  return parseFrames(bytes, offsetBytes);
};

/**
 * The agent entries a frame track needs. Without these the client renders
 * nothing: `buildViewerWorld` derives scene nodes from `rooms`/`agents`/
 * `signals`, and spatial samples only OVERRIDE an existing node's position.
 */
export const runFrameAgents = (track: RunFrameTrack): RunWorldTraceAgent[] => {
  const ids = new Set<string>();
  for (const sample of track.samples) {
    for (const object of sample.objects ?? []) ids.add(object.id);
  }
  return [...ids].sort().map((id) => ({
    id,
    label: id,
    scope: id,
    detail: "Body placed from the run record's recorded motion track."
  }));
};

/** The generic scene id for a dynamics run's single continuous-space floor. */
export const RUN_FRAME_ROOM_ID = "room:frames";

/**
 * The one floor a continuous-space run needs. `readRunSpatialWorld` returns
 * `undefined` for a dynamics run (it has no manifest `world.places/routes/
 * presence` — it has positions, not room presence), so without this the client
 * has no room geometry to place nodes against at all.
 *
 * Sized and centred from the header `bounds`, which is genre-neutral by
 * contract: this code never learns what kind of scene it is drawing. A run
 * whose provider declared no bounds gets no room and the client falls back to
 * its own default extent rather than being handed an invented one.
 */
export const runFrameRoom = (track: RunFrameTrack): RunWorldTraceRoom[] => {
  const bounds = track.bounds;
  if (bounds === undefined) return [];
  const width = bounds.max[0] - bounds.min[0];
  const depth = bounds.max[1] - bounds.min[1];
  return [{
    id: RUN_FRAME_ROOM_ID,
    kind: "room",
    label: "scene",
    scope: RUN_FRAME_ROOM_ID,
    members: [],
    // `scale` is the floor's FULL extent in world units (the client draws
    // `center ± size/2`), so bodies recorded inside `bounds` land on it.
    scale: [width, depth],
    scene: [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, 0]
  }];
};

/**
 * Folds a recorded motion track into a run's world trace. Isolated here rather
 * than inlined in `server.ts` because every line of it is load-bearing for
 * whether the page draws anything at all (B192):
 *
 *  - `agents[]` must gain an entry per frame object. `buildViewerWorld`
 *    derives scene nodes from `rooms`/`agents`/`signals` only, and spatial
 *    samples merely OVERRIDE an existing node's position — no agent, no node,
 *    no body on screen.
 *  - a bounded track's floor REPLACES the placeless informational anchor
 *    (`NO_PLACE_CAPTION`) the room-less branch emits: that anchor is a
 *    1.35x0.9 caption tile, not a scene bodies can move across. With no
 *    declared bounds the run keeps whatever rooms it already had.
 *  - `tick_duration_ms` must travel with the samples. Recorded velocities are
 *    per SECOND and the client's Hermite tangent scales them by a duration
 *    derived from this value, silently defaulting to 20ms without it.
 *
 * A run with no frames (any chat-only observe run) passes through untouched.
 */
export const applyRunFrameTrack = (
  world: RunWorldTrace,
  track: RunFrameTrack | undefined
): RunWorldTrace => {
  if (track === undefined || track.samples.length === 0) return world;
  const rooms = runFrameRoom(track);
  const existingAgentIds = new Set(world.agents.map(({ id }) => id));
  const addedAgents = runFrameAgents(track).filter(({ id }) => !existingAgentIds.has(id));
  const replaceRooms = world.rooms.length === 0
    || world.rooms.every(({ access_hint }) => access_hint === NO_PLACE_CAPTION);
  const samplesByTick = new Map(track.samples.map((sample) => [sample.tick, sample]));
  // A sealed producer projection can carry an authoritative terminal sample
  // newer than the last observer poll. It wins same-tick ties and survives a
  // shorter captured track; the observer track still fills its live prefix.
  for (const sample of world.spatial_samples) samplesByTick.set(sample.tick, sample);
  return {
    ...world,
    agents: [...world.agents, ...addedAgents],
    rooms: replaceRooms && rooms.length > 0 ? rooms : world.rooms,
    spatial_samples: [...samplesByTick.values()].sort((left, right) => left.tick - right.tick),
    tick_duration_ms: track.tickDurationMs
  };
};
