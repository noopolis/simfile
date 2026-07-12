import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  exportMoltnetTranscript,
  roomTranscriptTargetFromScope,
  type MoltnetExportedTranscript
} from "../moltnet/transcript-export.js";
import { parseSimfileSource } from "../schema/parse.js";
import { parseClockSpec } from "../runtime/clock.js";
import { compileRuntime } from "../runtime/trace-compile.js";
import { clampAndRound } from "../runtime/numeric.js";

import {
  composeRunManifest,
  sha256HexOfBuffer,
  type ComposeRunManifestWorld
} from "./composeRunManifest.js";
import { DEFAULT_QUIET_GRACE_MS, resolveTargetTurns, type ExchangeEndReason } from "./exchangeWait.js";
import {
  allMembersConnected,
  getMoltnetRoom,
  listMoltnetAgents,
  moltnetHealthy
} from "./moltnetRoomClient.js";
import { defaultSleep, pollUntilReady } from "./poll.js";
import {
  runSpawnfileArtifactsExport,
  runSpawnfileDown,
  runSpawnfileUp,
  type SpawnfileCliContext
} from "./spawnfileCli.js";
import { createWorldLedgerWriter } from "./worldLedgerWriter.js";
import { assertWorldRuleContentClean, buildSeedDeclarationFromMemoryDoc } from "./worldSeedLint.js";
import { runLiveTickLoop, type LiveTickLoopResult } from "./worldTickLoop.js";

/**
 * Memetics increment (a)'s live world-driven variant of
 * `composedOfficeSimDriver.ts`. That file's own charter — seed-once,
 * poll-read-only, shell spawnfile only through its three documented `--json`
 * subcommands, zero Docker/runtime-auth/Spawnfile-TS-imports here — still
 * holds. What changes is the core loop: instead of one operator-authored
 * seed message, the Simfile WORLD itself (`worldPath`) runs as a live tick
 * loop between "org ready" and "concluded" — ingesting room messages,
 * stepping `stepSimfileTick` once per wall-clock poll, scanning the tick's
 * own ingested messages for marker tokens, delivering any rule-emitted
 * `world.message`/`wake.recommended`, and appending everything to
 * `raw/world/causal.jsonl` — so the room's opening message (the `kickoff`
 * rule) comes from the world's own ledger, not a driver-injected string.
 * There is deliberately no "seed message" builder in this file: "seed" is
 * reserved for the Decision-13 doc-seeded secret (`seed_declaration`); the
 * room's own opening line is the world's `kickoff` rule, delivered like any
 * other rule-emitted world-effect event.
 */
export interface RunWorldDrivenOfficeSimOptions {
  spawnfileBin: string;
  /** Path to the composed org (e.g. `fixtures/sims/office-secret-v0/org`). */
  orgPath: string;
  /** Path to the Simfile world file driving this run. */
  worldPath: string;
  containerName: string;
  deploymentName: string;
  compiledOutputDirectory: string;
  runsRootDirectory: string;
  networkId?: string;
  roomId?: string;
  agentIds?: readonly string[];
  /** Agent whose `workspace.docs.memory` carries the Decision-13 secret. */
  seedAgentId?: string;
  /** Absolute path to the seed agent's memory doc; defaults to
   * `<orgPath>/agents/<seedAgentId>/MEMORY.md`. */
  memoryDocPath?: string;
  /** The memetics token set to lint the world against and declare as seeded. */
  tokenSet?: readonly string[];
  targetTurns?: number;
  quietGraceMs?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Safety fuse on world ticks, independent of the timeout/turn-cap stop
   * conditions below (which are expected to fire first in any healthy run). */
  maxTicks?: number;
  removeVolumesOnDown?: boolean;
  now?: () => Date;
}

export interface RunWorldDrivenOfficeSimResult {
  runDir: string;
  runId: string;
  endedReason: ExchangeEndReason;
  ticksRun: number;
  markerFired: boolean;
  agentTurnCount: number;
}

const DEFAULT_NETWORK_ID = "office_lab";
const DEFAULT_ROOM_ID = "office-room";
const DEFAULT_AGENT_IDS = ["eleanor", "sam"] as const;
const DEFAULT_SEED_AGENT_ID = "eleanor";
const DEFAULT_TOKEN_SET = ["Rosa Delgado"] as const;
const DEFAULT_TIMEOUT_MS = 240_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_TICKS = 200;

const collapseEngineDisclosure = (engines: readonly { agent: string; engine: string }[] | undefined): string => {
  const distinct = [...new Set((engines ?? []).map((entry) => entry.engine))].sort();
  return distinct.length === 0 ? "unknown" : distinct.join("+");
};

const waitForMoltnetReady = async (
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

const relativeArtifactPath = (runDir: string, absolutePath: string): string =>
  path.relative(runDir, absolutePath).split(path.sep).join("/");

const hashedArtifact = async (runDir: string, absolutePath: string): Promise<{ path: string; sha256: string }> => ({
  path: relativeArtifactPath(runDir, absolutePath),
  sha256: sha256HexOfBuffer(await readFile(absolutePath))
});

const writeTranscriptArtifact = async (
  runDir: string,
  transcript: MoltnetExportedTranscript
): Promise<{ path: string; sha256: string }> => {
  const absolutePath = path.join(runDir, "raw", "moltnet", "transcript.json");
  await writeFile(absolutePath, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
  return hashedArtifact(runDir, absolutePath);
};

export const runWorldDrivenOfficeSim = async (
  options: RunWorldDrivenOfficeSimOptions
): Promise<RunWorldDrivenOfficeSimResult> => {
  const cliContext: SpawnfileCliContext = { spawnfileBin: options.spawnfileBin };
  const networkId = options.networkId ?? DEFAULT_NETWORK_ID;
  const roomId = options.roomId ?? DEFAULT_ROOM_ID;
  const agentIds = options.agentIds ?? DEFAULT_AGENT_IDS;
  const seedAgentId = options.seedAgentId ?? DEFAULT_SEED_AGENT_ID;
  const tokenSet = options.tokenSet ?? DEFAULT_TOKEN_SET;
  const memoryDocPath = options.memoryDocPath ?? path.join(options.orgPath, "agents", seedAgentId, "MEMORY.md");
  const targetTurns = resolveTargetTurns(options.targetTurns);
  const quietGraceMs = options.quietGraceMs ?? DEFAULT_QUIET_GRACE_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollOptions = {
    intervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    sleep: defaultSleep,
    timeoutMs
  };
  const maxTicks = options.maxTicks ?? DEFAULT_MAX_TICKS;
  const now = options.now ?? (() => new Date());

  const worldSource = await readFile(options.worldPath, "utf8");
  const { simfile } = parseSimfileSource(worldSource, { path: options.worldPath });
  assertWorldRuleContentClean(simfile, tokenSet);

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
  const createdAt = now().toISOString();

  let loopResult: LiveTickLoopResult;
  try {
    await waitForMoltnetReady(baseUrl, roomId, agentIds, pollOptions);

    const clock = parseClockSpec(simfile.clock);
    const runtime = compileRuntime(simfile);
    const precision = 6;
    const state: Record<string, number> = {};
    for (const [id, value] of Object.entries(runtime.initialState)) {
      const range = runtime.ranges.get(id);
      if (!range) {
        throw new Error(`variable ${id} missing range`);
      }
      state[id] = clampAndRound(value, range, precision);
    }

    const ledgerWriter = await createWorldLedgerWriter(runDir, runId);

    loopResult = await runLiveTickLoop({
      baseUrl,
      networkId,
      roomId,
      roomScope: `room:${networkId}:${roomId}`,
      agentIds,
      clock,
      runtime,
      simfile,
      state,
      precision,
      runId,
      seed: simfile.clock.seed,
      ledgerWriter,
      pollOptions,
      targetTurns,
      quietGraceMs,
      timeoutMs,
      maxTicks
    });

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

    const worldLedgerWriter = ledgerWriter;
    const worldArtifacts = await Promise.all([
      hashedArtifact(runDir, worldLedgerWriter.causalJsonlPath),
      hashedArtifact(runDir, worldLedgerWriter.telemetryJsonPath),
      hashedArtifact(runDir, worldLedgerWriter.ingestedMessagesPath)
    ]);

    const seedDeclaration = await buildSeedDeclarationFromMemoryDoc({
      memoryDocPath,
      tokenSet,
      seedAgent: seedAgentId,
      seedEpoch: createdAt
    });

    const world: ComposeRunManifestWorld = { network_id: networkId, room_id: roomId, members: [...agentIds].sort() };
    const manifest = composeRunManifest({
      runId,
      createdAt,
      fingerprint: upReceipt.fingerprint,
      engine: collapseEngineDisclosure(upReceipt.engines),
      world,
      exportedArtifacts: exportResult.index.files,
      extraArtifacts: [transcriptArtifact, ...worldArtifacts],
      seedDeclaration
    });
    await writeFile(path.join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } catch (error) {
    await runSpawnfileDown(cliContext, {
      orgPath: options.orgPath,
      deploymentName: options.deploymentName,
      compiledOutputDirectory: options.compiledOutputDirectory,
      removeVolumes: options.removeVolumesOnDown ?? true
    }).catch(() => undefined);
    throw error;
  }

  return {
    runDir,
    runId,
    endedReason: loopResult.endedReason,
    ticksRun: loopResult.ticksRun,
    markerFired: loopResult.markerFired,
    agentTurnCount: loopResult.agentTurnCount
  };
};
