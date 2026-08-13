import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { verifyManifestArtifacts } from "../observe/artifacts.js";
import { parseRunManifest } from "../observe/manifest.js";
import { assertSecretFreeComposedJson } from "./json.js";

export const COMPOSED_REPLAY_EXPECTATION_VERSION =
  "simfile.composed-replay-expectation.v1" as const;
export interface ComposedRecordedAction {
  readonly action: unknown;
  readonly boundary_tick: number;
  readonly ordinal: number;
}
export interface ComposedReplayAdapter<State = unknown> {
  restore(initialCheckpoint: unknown): State | Promise<State>;
  inject(input: Readonly<{ action: unknown; boundary_tick: number; ordinal: number;
    state: State }>): void | Promise<void>;
  finish(state: State): Readonly<{ probe: Uint8Array; terminal_state: Uint8Array;
    terminal_tick: number }> | Promise<Readonly<{ probe: Uint8Array;
      terminal_state: Uint8Array; terminal_tick: number }>>;
}
export interface ComposedReplayReceipt {
  readonly accepted_action_count: number;
  readonly exact: true;
  readonly probe_sha256: string;
  readonly run_id: string;
  readonly terminal_state_sha256: string;
  readonly terminal_tick: number;
  readonly version: "simfile.composed-replay-receipt.v1";
}

const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const exactObject = (raw: unknown, keys: readonly string[], label: string): Record<string, unknown> => {
  assertSecretFreeComposedJson(raw);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)
    || Object.keys(raw).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new TypeError(`composed replay ${label} is invalid`);
  }
  return raw as Record<string, unknown>;
};
const parseAction = (raw: unknown, expectedOrdinal: number): ComposedRecordedAction => {
  const value = exactObject(raw, ["action", "boundary_tick", "ordinal"], "action");
  if (!Number.isSafeInteger(value.boundary_tick) || (value.boundary_tick as number) < 0
    || value.ordinal !== expectedOrdinal) {
    throw new TypeError("composed replay action boundary is invalid");
  }
  return Object.freeze({ action: value.action, boundary_tick: value.boundary_tick as number,
    ordinal: expectedOrdinal });
};
const parseActions = (bytes: Uint8Array): readonly ComposedRecordedAction[] => {
  const text = new TextDecoder("utf8", { fatal: true }).decode(bytes);
  if (text.length === 0) return Object.freeze([]);
  if (!text.endsWith("\n")) throw new TypeError("composed replay action stream is truncated");
  const lines = text.split("\n").slice(0, -1);
  const actions = lines.map((line, ordinal) => parseAction(JSON.parse(line) as unknown, ordinal));
  for (let index = 1; index < actions.length; index += 1) {
    if (actions[index]!.boundary_tick < actions[index - 1]!.boundary_tick) {
      throw new TypeError("composed replay action boundary regressed");
    }
  }
  return Object.freeze(actions);
};

interface ReplayExpectation {
  readonly accepted_action_count: number;
  readonly action_stream_sha256: string;
  readonly initial_checkpoint_sha256: string;
  readonly probe_sha256: string;
  readonly terminal_state_sha256: string;
  readonly terminal_tick: number;
}
const parseExpectation = (raw: unknown): ReplayExpectation => {
  const value = exactObject(raw, [
    "accepted_action_count", "action_stream_sha256", "initial_checkpoint_sha256",
    "probe_sha256", "terminal_state_sha256", "terminal_tick", "version",
  ], "expectation");
  const hashes = ["action_stream_sha256", "initial_checkpoint_sha256",
    "probe_sha256", "terminal_state_sha256"] as const;
  if (value.version !== COMPOSED_REPLAY_EXPECTATION_VERSION
    || !Number.isSafeInteger(value.accepted_action_count)
    || (value.accepted_action_count as number) < 0
    || !Number.isSafeInteger(value.terminal_tick) || (value.terminal_tick as number) < 1
    || hashes.some((key) => typeof value[key] !== "string"
      || !/^[a-f0-9]{64}$/u.test(value[key] as string))) {
    throw new TypeError("composed replay expectation is invalid");
  }
  return value as unknown as ReplayExpectation;
};

/** Replays a sealed record through an injected mechanics-only adapter. */
export const replayComposedRunRecord = async <State>(input: Readonly<{
  adapter: ComposedReplayAdapter<State>;
  run_dir: string;
}>): Promise<ComposedReplayReceipt> => {
  const runDir = path.resolve(input.run_dir);
  const manifest = parseRunManifest(JSON.parse(
    await readFile(path.join(runDir, "manifest.json"), "utf8"),
  ) as unknown);
  const integrity = await verifyManifestArtifacts(runDir, manifest.artifacts);
  const failed = integrity.find(({ ok }) => !ok);
  if (failed !== undefined) throw new TypeError(`composed replay artifact mismatch: ${failed.path}`);
  const required = ["replay/initial-checkpoint.json", "replay/accepted-actions.jsonl",
    "replay/expected.json"] as const;
  const declared = new Set(manifest.artifacts.map(({ path: artifactPath }) => artifactPath));
  if (required.some((artifactPath) => !declared.has(artifactPath))) {
    throw new TypeError("composed replay artifacts are incomplete");
  }
  const [checkpointBytes, actionBytes, expectationBytes] = await Promise.all(
    required.map((relative) => readFile(path.join(runDir, relative))),
  );
  const expectation = parseExpectation(JSON.parse(expectationBytes.toString("utf8")) as unknown);
  const actions = parseActions(actionBytes);
  if (digest(checkpointBytes) !== expectation.initial_checkpoint_sha256
    || digest(actionBytes) !== expectation.action_stream_sha256
    || actions.length !== expectation.accepted_action_count
    || actions.some(({ boundary_tick }) => boundary_tick >= expectation.terminal_tick)) {
    throw new TypeError("composed replay input correlation is invalid");
  }
  const checkpoint = JSON.parse(checkpointBytes.toString("utf8")) as unknown;
  assertSecretFreeComposedJson(checkpoint);
  const state = await input.adapter.restore(checkpoint);
  for (const action of actions) await input.adapter.inject({ ...action, state });
  const result = await input.adapter.finish(state);
  const terminalStateDigest = digest(result.terminal_state);
  const probeDigest = digest(result.probe);
  if (result.terminal_tick !== expectation.terminal_tick
    || terminalStateDigest !== expectation.terminal_state_sha256
    || probeDigest !== expectation.probe_sha256) {
    throw new TypeError("composed replay exact comparison failed");
  }
  return Object.freeze({
    accepted_action_count: actions.length, exact: true, probe_sha256: probeDigest,
    run_id: manifest.run_id, terminal_state_sha256: terminalStateDigest,
    terminal_tick: result.terminal_tick, version: "simfile.composed-replay-receipt.v1",
  });
};
