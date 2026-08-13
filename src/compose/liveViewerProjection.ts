import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { assertSecretFreeComposedJson, digestComposedJson } from "./json.js";
import type { ComposedViewerBinding } from "./viewerBinding.js";
import type { ComposedRunRecord } from "./runRecord.js";

const FRAMES_PATH = "raw/frames.jsonl";
const SOURCE_LEDGER_PATH = "provenance/viewer-projection-sources.jsonl";
const LIVE_DECLARATION_PATH = "viewer-extension-data.json";
const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const finitePair = (value: unknown): [number, number] | undefined =>
  Array.isArray(value) && value.length === 2
    && value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
    ? [value[0] as number, value[1] as number]
    : undefined;

interface ProjectionObject {
  readonly id: string;
  readonly position: [number, number];
  readonly velocity: [number, number];
}
interface ProjectionSample {
  readonly discontinuities?: readonly string[];
  readonly objects: readonly ProjectionObject[];
  readonly occupancy: Readonly<Record<string, readonly string[]>>;
  readonly tick: number;
  readonly transit: readonly Readonly<{
    agent: string;
    from_room: string;
    path_id: string;
    ticks_remaining: number;
    to_room: string;
  }>[];
}
interface ProjectionTrace {
  readonly playback_status?: string;
  readonly rooms: readonly unknown[];
  readonly run_id: string;
  readonly samples: readonly ProjectionSample[];
  readonly tick_duration_ms: number;
}

const parseTrace = (bytes: Uint8Array, runId: string): ProjectionTrace => {
  const raw = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  if (!isRecord(raw) || raw.version !== "viewer.trace.v1" || raw.run_id !== runId
    || typeof raw.run_name !== "string"
    || !Array.isArray(raw.rooms) || !Array.isArray(raw.corridors)
    || !Array.isArray(raw.agents) || !Array.isArray(raw.presence)
    || !Array.isArray(raw.ledger_facts) || !Array.isArray(raw.signals)
    || !Array.isArray(raw.spatial_samples)) {
    throw new TypeError("composed live viewer trace is invalid");
  }
  if (raw.playback_status !== undefined
    && (typeof raw.playback_status !== "string"
      || !["live", "completed", "failed"].includes(raw.playback_status))) {
    throw new TypeError("composed live viewer playback status is invalid");
  }
  if (raw.tick_duration_ms !== undefined
    && (typeof raw.tick_duration_ms !== "number"
      || !Number.isFinite(raw.tick_duration_ms) || raw.tick_duration_ms <= 0)) {
    throw new TypeError("composed live viewer tick duration is invalid");
  }
  const ticks = new Set<number>();
  const samples = raw.spatial_samples.map((sample): ProjectionSample => {
    if (!isRecord(sample) || !Number.isSafeInteger(sample.tick)
      || (sample.tick as number) < 0 || ticks.has(sample.tick as number)
      || (sample.objects !== undefined && !Array.isArray(sample.objects))) {
      throw new TypeError("composed live viewer trace sample is invalid");
    }
    ticks.add(sample.tick as number);
    const discontinuities = sample.discontinuities;
    if (discontinuities !== undefined && (!Array.isArray(discontinuities)
      || discontinuities.some((id) => typeof id !== "string"))) {
      throw new TypeError("composed live viewer trace sample is invalid");
    }
    const occupancy = sample.occupancy;
    if (!isRecord(occupancy) || Object.values(occupancy).some((ids) =>
      !Array.isArray(ids) || ids.some((id) => typeof id !== "string"))) {
      throw new TypeError("composed live viewer trace sample is invalid");
    }
    if (!Array.isArray(sample.transit)) {
      throw new TypeError("composed live viewer trace sample is invalid");
    }
    const transit = sample.transit.map((entry) => {
      const ticksRemaining = isRecord(entry) ? entry.ticks_remaining : undefined;
      if (!isRecord(entry) || typeof entry.agent !== "string"
        || typeof entry.from_room !== "string" || typeof entry.path_id !== "string"
        || !Number.isSafeInteger(ticksRemaining) || (ticksRemaining as number) < 0
        || typeof entry.to_room !== "string") {
        throw new TypeError("composed live viewer trace transit is invalid");
      }
      return Object.freeze({
        agent: entry.agent, from_room: entry.from_room, path_id: entry.path_id,
        ticks_remaining: ticksRemaining as number, to_room: entry.to_room,
      });
    });
    const ids = new Set<string>();
    const objects = (sample.objects ?? []).map((object): ProjectionObject => {
      if (!isRecord(object) || typeof object.id !== "string" || object.id.length === 0
        || ids.has(object.id)) {
        throw new TypeError("composed live viewer trace object is invalid");
      }
      const position = finitePair(object.position);
      const velocity = object.velocity === undefined ? [0, 0] as [number, number]
        : finitePair(object.velocity);
      if (position === undefined || velocity === undefined) {
        throw new TypeError("composed live viewer trace object is invalid");
      }
      ids.add(object.id);
      return Object.freeze({ id: object.id, position, velocity });
    });
    return Object.freeze({
      ...(discontinuities === undefined ? {} : {
        discontinuities: Object.freeze([...discontinuities] as string[]),
      }),
      objects: Object.freeze(objects),
      occupancy: Object.freeze(Object.fromEntries(Object.entries(occupancy).map(
        ([room, ids]) => [room, Object.freeze([...(ids as string[])])],
      ))),
      tick: sample.tick as number,
      transit: Object.freeze(transit),
    });
  });
  const duration = raw.tick_duration_ms;
  return Object.freeze({
    ...(typeof raw.playback_status === "string"
      ? { playback_status: raw.playback_status }
      : {}),
    rooms: raw.rooms,
    run_id: raw.run_id,
    samples: Object.freeze(samples),
    tick_duration_ms: typeof duration === "number" && Number.isFinite(duration)
      && duration > 0 ? duration : 20,
  });
};

const boundsFor = (trace: ProjectionTrace): Readonly<{
  max: [number, number]; min: [number, number];
}> => {
  const extents: Array<readonly [number, number, number, number]> = [];
  for (const room of trace.rooms) {
    if (!isRecord(room) || !Array.isArray(room.scene) || room.scene.length < 2) continue;
    const center = finitePair(room.scene.slice(0, 2));
    const scale = finitePair(room.scale);
    if (center !== undefined && scale !== undefined && scale[0] > 0 && scale[1] > 0) {
      extents.push([center[0] - scale[0] / 2, center[1] - scale[1] / 2,
        center[0] + scale[0] / 2, center[1] + scale[1] / 2]);
    }
  }
  if (extents.length === 0) {
    for (const sample of trace.samples) {
      for (const object of sample.objects) {
        extents.push([object.position[0], object.position[1],
          object.position[0], object.position[1]]);
      }
    }
  }
  if (extents.length === 0) return { max: [1, 1], min: [-1, -1] };
  const minX = Math.min(...extents.map((extent) => extent[0]));
  const minY = Math.min(...extents.map((extent) => extent[1]));
  const maxX = Math.max(...extents.map((extent) => extent[2]));
  const maxY = Math.max(...extents.map((extent) => extent[3]));
  return {
    max: [maxX === minX ? maxX + 1 : maxX, maxY === minY ? maxY + 1 : maxY],
    min: [maxX === minX ? minX - 1 : minX, maxY === minY ? minY - 1 : minY],
  };
};

const atomicWrite = async (target: string, bytes: Uint8Array): Promise<void> => {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.pending`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
};

export interface VerifiedViewerProjectionSource {
  readonly artifact_id: string;
  readonly content_digest: string;
  readonly media_type: string;
  readonly request: Readonly<Record<string, unknown>>;
  readonly request_digest: string;
  readonly response_version: "spawnfile.target-public-artifact-snapshot.v1";
  readonly run_id: string;
  readonly size_bytes: number;
}

export interface ComposedLiveViewerProjection {
  finalize(record: Pick<ComposedRunRecord, "writeArtifacts">): Promise<Readonly<{
    frontier_tick: number;
    publications: number;
  }>>;
  publish(bytes: Uint8Array, source: VerifiedViewerProjectionSource): Promise<void>;
}

/** Mirrors authenticated public snapshots into the observer-only live transport. */
export const createComposedLiveViewerProjection = (input: Readonly<{
  binding: ComposedViewerBinding;
  dependencies?: Readonly<{ before_write?: (relativePath: string) => void }>;
  run_id: string;
  staging_dir: string;
}>): ComposedLiveViewerProjection => {
  const live = input.binding.live_trace;
  if (live === undefined) throw new TypeError("composed live viewer binding is absent");
  const framesPath = path.join(input.staging_dir, FRAMES_PATH);
  const ledgerPath = path.join(input.staging_dir, SOURCE_LEDGER_PATH);
  const declarationPath = path.join(input.staging_dir, LIVE_DECLARATION_PATH);
  const stagedPaths = new Set<string>();
  const snapshots: Array<Readonly<{ bytes: Uint8Array; path: string }>> = [];
  let frontier = -1;
  let accepting = true;
  let declarationBytes: Uint8Array | undefined;
  let framesBytes: Uint8Array | undefined;
  let ledgerBytes: Uint8Array | undefined;
  let publication = 0;
  let pending: Promise<void> = Promise.resolve();

  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const result = pending.then(operation, operation);
    pending = result.catch(() => undefined);
    return result;
  };
  const removeTransientFiles = async (): Promise<void> => {
    // The declaration is the live generation commit marker. Remove it first
    // so a new reader cannot discover paths while their snapshot is removed.
    await rm(declarationPath, { force: true });
    await Promise.all([
      rm(framesPath, { force: true }),
      rm(ledgerPath, { force: true }),
      ...[...stagedPaths].map((relative) =>
        rm(path.join(input.staging_dir, relative), { force: true })),
    ]);
  };
  const writeLive = async (relative: string, bytes: Uint8Array): Promise<void> => {
    input.dependencies?.before_write?.(relative);
    await atomicWrite(path.join(input.staging_dir, relative), bytes);
  };
  const publish = async (
    bytes: Uint8Array,
    source: VerifiedViewerProjectionSource,
  ): Promise<void> => {
    if (!accepting) throw new TypeError("composed live viewer projection is closed");
    return enqueue(async () => {
      const digest = sha256(bytes);
      assertSecretFreeComposedJson(source.request);
      const requestedArtifact = source.request.artifact;
      if (source.artifact_id !== live.artifact.id
        || source.media_type !== live.artifact.media_type
        || source.run_id !== input.run_id
        || source.response_version !== "spawnfile.target-public-artifact-snapshot.v1"
        || source.size_bytes !== bytes.byteLength
        || source.size_bytes > live.artifact.max_bytes
        || source.content_digest !== `sha256:${digest}`
        || source.request_digest !== digestComposedJson(
          "spawnfile.target-public-artifact-snapshot.request.v1", source.request,
        )
        || source.request.run_id !== input.run_id
        || !isRecord(requestedArtifact)
        || requestedArtifact.id !== live.artifact.id
        || requestedArtifact.path !== live.artifact.path
        || requestedArtifact.media_type !== live.artifact.media_type
        || requestedArtifact.max_bytes !== live.artifact.max_bytes) {
        throw new TypeError("composed live viewer projection source is invalid");
      }
      const trace = parseTrace(bytes, input.run_id);
      const maxTick = trace.samples.reduce<number | undefined>((maximum, { tick }) =>
        maximum === undefined ? tick : Math.max(maximum, tick), undefined);
      if (frontier >= 0 && (maxTick === undefined || maxTick < frontier)) {
        throw new TypeError("composed live viewer projection frontier regressed");
      }
      const current = publication + 1;
      const relative = `provenance/viewer-snapshots/${String(current)
        .padStart(6, "0")}.json`;
      stagedPaths.add(relative);
      const fresh = [...trace.samples]
        .filter(({ tick }) => tick > frontier)
        .sort((left, right) => left.tick - right.tick);
      const header = framesBytes === undefined ? `${JSON.stringify({
        bounds: boundsFor(trace),
        sim_seconds_per_tick: trace.tick_duration_ms / 1_000,
        version: "simfile.dynamics-run-frames-header.v1",
      })}\n` : Buffer.from(framesBytes).toString("utf8");
      const candidateFrontier = fresh.at(-1)?.tick ?? frontier;
      const frameRows = fresh.map((sample) => `${JSON.stringify({
          ...(sample.discontinuities === undefined
            ? {} : { discontinuities: sample.discontinuities }),
          objects: sample.objects,
          occupancy: sample.occupancy,
          source_viewer_trace_sha256: digest,
          tick: sample.tick,
          transit: sample.transit,
          version: "simfile.dynamics-run-frame.v1",
        })}\n`).join("");
      const candidateFrames = Buffer.from(`${header}${frameRows}`);
      const ledgerPrefix = ledgerBytes === undefined
        ? "" : Buffer.from(ledgerBytes).toString("utf8");
      const candidateLedger = Buffer.from(`${ledgerPrefix}${JSON.stringify({
        artifact_id: source.artifact_id,
        content_digest: source.content_digest,
        extension_id: live.extension_id,
        frontier_tick: candidateFrontier,
        media_type: source.media_type,
        playback_status: trace.playback_status ?? "live",
        publication: current,
        request: source.request,
        request_digest: source.request_digest,
        response: {
          artifact_id: source.artifact_id,
          content_digest: source.content_digest,
          media_type: source.media_type,
          request_digest: source.request_digest,
          run_id: source.run_id,
          size_bytes: source.size_bytes,
          version: source.response_version,
        },
        run_id: source.run_id,
        sample_count: trace.samples.length,
        size_bytes: source.size_bytes,
        snapshot_path: relative,
        version: "simfile.composed-viewer-projection-source.v1",
      })}\n`);
      const candidateDeclaration = Buffer.from(`${JSON.stringify({
        extensions: [{ id: live.extension_id, path: relative, sha256: digest }],
        version: "simfile.viewer-extension-data.v1",
      })}\n`);
      const snapshotBytes = Uint8Array.from(bytes);
      try {
        await writeLive(relative, snapshotBytes);
        await writeLive(SOURCE_LEDGER_PATH, candidateLedger);
        await writeLive(FRAMES_PATH, candidateFrames);
        await writeLive(LIVE_DECLARATION_PATH, candidateDeclaration);
      } catch (error) {
        await rm(path.join(input.staging_dir, relative), { force: true })
          .catch(() => undefined);
        if (publication === 0) {
          await Promise.all([framesPath, ledgerPath, declarationPath].map((target) =>
            rm(target, { force: true }).catch(() => undefined)));
        } else {
          await Promise.all([
            writeLive(SOURCE_LEDGER_PATH, ledgerBytes!),
            writeLive(FRAMES_PATH, framesBytes!),
          ]).catch(() => undefined);
          await writeLive(LIVE_DECLARATION_PATH, declarationBytes!)
            .catch(() => undefined);
        }
        throw error;
      }
      snapshots.push(Object.freeze({ bytes: snapshotBytes, path: relative }));
      declarationBytes = candidateDeclaration;
      framesBytes = candidateFrames;
      frontier = candidateFrontier;
      ledgerBytes = candidateLedger;
      publication = current;
    });
  };

  return Object.freeze({
    finalize: async (record: Pick<ComposedRunRecord, "writeArtifacts">) => {
      accepting = false;
      await pending;
      if (publication === 0 || framesBytes === undefined || ledgerBytes === undefined) {
        await removeTransientFiles();
        return Object.freeze({ frontier_tick: frontier, publications: 0 });
      }
      await removeTransientFiles();
      await record.writeArtifacts([
        { bytes: ledgerBytes, path: SOURCE_LEDGER_PATH, role: "provenance" },
        ...snapshots.map(({ bytes: snapshot, path: snapshotPath }) => ({
          bytes: snapshot, path: snapshotPath, role: "provenance" as const,
        })),
        { bytes: framesBytes, path: FRAMES_PATH, role: "presentation" },
      ]);
      return Object.freeze({ frontier_tick: frontier, publications: publication });
    },
    publish,
  });
};
