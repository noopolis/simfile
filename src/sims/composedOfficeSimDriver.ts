import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  exportMoltnetTranscript,
  roomTranscriptTargetFromScope,
  type MoltnetExportedTranscript
} from "../moltnet/transcript-export.js";
import { sendWorldEventToMoltnet } from "../moltnet/world-participant.js";
import type { RuntimeTraceEvent } from "../runtime/types.js";

import {
  composeRunManifest,
  sha256HexOfBuffer,
  type ComposeRunManifestWorld
} from "./composeRunManifest.js";
import {
  DEFAULT_QUIET_GRACE_MS,
  resolveTargetTurns,
  waitForConversationExchange,
  type ConversationExchangeResult
} from "./exchangeWait.js";
import {
  allMembersConnected,
  getMoltnetRoom,
  listMoltnetAgents,
  listMoltnetRoomMessages,
  moltnetHealthy
} from "./moltnetRoomClient.js";
import { defaultSleep, pollUntilReady } from "./poll.js";
import {
  runSpawnfileArtifactsExport,
  runSpawnfileDown,
  runSpawnfileUp,
  type SpawnfileCliContext
} from "./spawnfileCli.js";

/**
 * The composed-run driver (Decision 21 / Piece 5 design's "MINIMAL
 * composed-run driver in simfile"): shells the three documented `spawnfile
 * ... --json` lifecycle subcommands, seeds the room exactly ONCE, polls
 * read-only, and assembles a sealed `runs/<id>/` directory `simfile observe`
 * can reconcile. Zero Docker, zero runtime auth, zero Spawnfile TS imports —
 * this package's charter. Any wait that would otherwise need a coax/retry is
 * a Phase-B platform defect to FILE, never something this driver papers over
 * by re-sending a mention.
 */
export interface RunComposedOfficeSimOptions {
  /** Path to Spawnfile's built CLI entrypoint (e.g. `dist/cli/index.js`). */
  spawnfileBin: string;
  /** Path to the composed office-sim org (`fixtures/sims/office-sim/org`). */
  orgPath: string;
  containerName: string;
  deploymentName: string;
  /** Scratch directory for spawnfile's own compile output + deployment record — separate from the sealed run-dir. */
  compiledOutputDirectory: string;
  /** Parent directory under which `runs/<run_id>/` is assembled. */
  runsRootDirectory: string;
  networkId?: string;
  roomId?: string;
  agentIds?: readonly string[];
  seedTargetAgentId?: string;
  seedMessageText?: string;
  targetTurns?: number;
  quietGraceMs?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Passed straight to `spawnfile down --volumes`; defaults true so a
   * composed run leaves nothing behind once its artifacts are safely
   * exported into the run-dir. */
  removeVolumesOnDown?: boolean;
  now?: () => Date;
}

export interface RunComposedOfficeSimResult {
  runDir: string;
  runId: string;
  exchange: ConversationExchangeResult;
}

const DEFAULT_NETWORK_ID = "office_lab";
const DEFAULT_ROOM_ID = "office-room";
const DEFAULT_AGENT_IDS = ["eleanor", "sam"] as const;
const DEFAULT_SEED_TARGET = "eleanor";
const DEFAULT_SEED_TEXT =
  "@eleanor We need to finalize the office pilot rollout with Sam: propose the pilot office and a target date for the file migration, and get Sam's agreement.";
const DEFAULT_TIMEOUT_MS = 240_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** Collapses `up-receipt.engines[]` to one disclosure string for the run
 * manifest: every agent's declared engine when they all agree (true for this
 * composed office-sim, where both agents run `scripted`), else a sorted
 * comma-joined list so a mixed-engine run is still visibly disclosed. */
const collapseEngineDisclosure = (engines: readonly { agent: string; engine: string }[] | undefined): string => {
  const distinct = [...new Set((engines ?? []).map((entry) => entry.engine))].sort();
  if (distinct.length === 0) return "unknown";
  return distinct.join("+");
};

const waitForMoltnetReadyForSeed = async (
  baseUrl: string,
  roomId: string,
  agentIds: readonly string[],
  pollOptions: { intervalMs: number; sleep: (ms: number) => Promise<void>; timeoutMs: number }
): Promise<void> => {
  await pollUntilReady("moltnet health", pollOptions, async () => ((await moltnetHealthy(baseUrl)) ? true : null));
  await pollUntilReady(`moltnet room ${roomId} membership`, pollOptions, async () => {
    const room = await getMoltnetRoom(baseUrl, roomId);
    const expected = [...agentIds].sort();
    const actual = [...room.members].sort();
    return expected.length === actual.length && expected.every((id, index) => actual[index] === id) ? room : null;
  });
  await pollUntilReady(`moltnet bridge attachments for ${roomId}`, pollOptions, async () => {
    const agents = await listMoltnetAgents(baseUrl);
    return allMembersConnected(agents, roomId, agentIds) ? agents : null;
  });
};

/** Builds the single seed `world.message` event this driver ever sends —
 * the ONE write in the whole flow. Everything else is a GET. */
const buildSeedEvent = (
  networkId: string,
  roomId: string,
  seedTargetAgentId: string,
  seedMessageText: string
): RuntimeTraceEvent => ({
  event_id: `seed-${Date.now()}`,
  kind: "world.message",
  target: `room:${networkId}:${roomId}`,
  sim_time: 0,
  provenance: "external",
  actor: `operator:${seedTargetAgentId}`,
  scope: "global",
  payload: { content: seedMessageText }
});

const writeTranscriptArtifact = async (
  runDir: string,
  transcript: MoltnetExportedTranscript
): Promise<{ path: string; sha256: string }> => {
  const relativePath = path.posix.join("raw", "moltnet", "transcript.json");
  const absolutePath = path.join(runDir, "raw", "moltnet", "transcript.json");
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const content = `${JSON.stringify(transcript, null, 2)}\n`;
  await writeFile(absolutePath, content, "utf8");
  return { path: relativePath, sha256: sha256HexOfBuffer(Buffer.from(content, "utf8")) };
};

/**
 * Runs the composed office-sim end to end: `spawnfile up` (detached) ->
 * poll-read-only for moltnet health/room/bridge readiness -> seed the room
 * ONCE -> poll-read-only for the exchange to conclude -> `spawnfile
 * artifacts export` -> fetch the moltnet transcript (while the container is
 * still live — export/transcript both need the running deployment) ->
 * `spawnfile down` -> compose and write `manifest.json` LAST. Returns the
 * sealed run-dir path for `simfile observe` to reconcile.
 */
export const runComposedOfficeSim = async (
  options: RunComposedOfficeSimOptions
): Promise<RunComposedOfficeSimResult> => {
  const cliContext: SpawnfileCliContext = { spawnfileBin: options.spawnfileBin };
  const networkId = options.networkId ?? DEFAULT_NETWORK_ID;
  const roomId = options.roomId ?? DEFAULT_ROOM_ID;
  const agentIds = options.agentIds ?? DEFAULT_AGENT_IDS;
  const seedTargetAgentId = options.seedTargetAgentId ?? DEFAULT_SEED_TARGET;
  const seedMessageText = options.seedMessageText ?? DEFAULT_SEED_TEXT;
  const targetTurns = resolveTargetTurns(options.targetTurns);
  const quietGraceMs = options.quietGraceMs ?? DEFAULT_QUIET_GRACE_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollOptions = {
    intervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    sleep: defaultSleep,
    timeoutMs
  };
  const now = options.now ?? (() => new Date());

  const upReceipt = await runSpawnfileUp(cliContext, {
    orgPath: options.orgPath,
    containerName: options.containerName,
    deploymentName: options.deploymentName,
    compiledOutputDirectory: options.compiledOutputDirectory
  });

  if (!upReceipt.run_id) {
    throw new Error("spawnfile up-receipt had no run_id; cannot assemble a run directory");
  }
  const baseUrl = upReceipt.readiness.moltnet_base_url;
  if (!baseUrl) {
    throw new Error("spawnfile up-receipt had no moltnet_base_url; is human_ingress enabled on the network?");
  }

  const runId = upReceipt.run_id;
  const runDir = path.join(options.runsRootDirectory, runId);

  let exchange: ConversationExchangeResult;
  try {
    await waitForMoltnetReadyForSeed(baseUrl, roomId, agentIds, pollOptions);

    const baseline = await listMoltnetRoomMessages(baseUrl, roomId, 200);
    const baselineIds = new Set(baseline.map((message) => message.id));

    // The ONE write this driver performs — everything else is a read.
    await sendWorldEventToMoltnet(buildSeedEvent(networkId, roomId, seedTargetAgentId, seedMessageText), {
      baseUrl,
      networkId
    });

    exchange = await waitForConversationExchange(baseUrl, roomId, baselineIds, {
      agentIds,
      intervalMs: pollOptions.intervalMs,
      quietGraceMs,
      sleep: pollOptions.sleep,
      targetTurns,
      timeoutMs
    });

    // Export before teardown, and fetch the transcript while the container
    // (and therefore moltnet's HTTP API) is still live — both need the
    // running deployment, so both happen before `spawnfile down`.
    const exportResult = await runSpawnfileArtifactsExport(cliContext, {
      orgPath: options.orgPath,
      deploymentName: options.deploymentName,
      compiledOutputDirectory: options.compiledOutputDirectory,
      destinationDirectory: runDir
    });

    const transcript = await exportMoltnetTranscript({
      baseUrl,
      targets: [roomTranscriptTargetFromScope(`room:${networkId}:${roomId}`)]
    });
    const transcriptArtifact = await writeTranscriptArtifact(runDir, transcript);

    await runSpawnfileDown(cliContext, {
      orgPath: options.orgPath,
      deploymentName: options.deploymentName,
      compiledOutputDirectory: options.compiledOutputDirectory,
      removeVolumes: options.removeVolumesOnDown ?? true
    });

    const world: ComposeRunManifestWorld = { network_id: networkId, room_id: roomId, members: [...agentIds].sort() };
    const manifest = composeRunManifest({
      runId,
      createdAt: now().toISOString(),
      fingerprint: upReceipt.fingerprint,
      engine: collapseEngineDisclosure(upReceipt.engines),
      world,
      exportedArtifacts: exportResult.index.files,
      extraArtifacts: [transcriptArtifact]
    });
    await writeFile(path.join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } catch (error) {
    // Best-effort teardown on failure so a broken run never leaks a live
    // container/volumes; the original error is what's reported.
    await runSpawnfileDown(cliContext, {
      orgPath: options.orgPath,
      deploymentName: options.deploymentName,
      compiledOutputDirectory: options.compiledOutputDirectory,
      removeVolumes: options.removeVolumesOnDown ?? true
    }).catch(() => undefined);
    throw error;
  }

  return { runDir, runId, exchange };
};
