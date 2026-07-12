import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  exportMoltnetTranscript,
  roomTranscriptTargetFromScope
} from "../moltnet/transcript-export.js";
import { sendWorldEventToMoltnet } from "../moltnet/world-participant.js";
import type { RuntimeTraceEvent } from "../runtime/types.js";
import type { RunManifestArtifactEntry } from "../observe/manifest.js";

import { composeRunManifest, sha256HexOfBuffer } from "./composeRunManifest.js";
import {
  allMembersConnected,
  getMoltnetRoom,
  listMoltnetAgents,
  listMoltnetRoomMessages,
  moltnetHealthy
} from "./moltnetRoomClient.js";
import { defaultSleep, pollUntilReady, type PollOptions } from "./poll.js";
import {
  runSpawnfileArtifactsExport,
  runSpawnfileDown,
  runSpawnfileUp,
  type SpawnfileCliContext
} from "./spawnfileCli.js";

/**
 * The MULTI-NETWORK composed-run driver: the jungian psyche generalization of
 * `composedOfficeSimDriver.ts`. It runs a recursive Spawnfile org — a psyche
 * floor whose members are self-teams, each owning its OWN inner Moltnet council
 * network — as one composed sim, then assembles a run-dir `simfile observe`
 * reconciles and `simfile view` descends into. Same charter as the office
 * driver: shells `spawnfile up/artifacts export/down --json` only, seeds the
 * floor exactly ONCE, and every other step is a read-only poll. The interior
 * deliberation (representative -> inner council -> back to the floor) is driven
 * entirely by the agents' own wake-across-membranes plumbing, never coaxed
 * here.
 */
export interface RunComposedJungianSimOptions {
  spawnfileBin: string;
  /** Path to the composed jungian org (`fixtures/sims/jungian-daimon-org/org`). */
  orgPath: string;
  containerName: string;
  deploymentName: string;
  /** Scratch dir for spawnfile's compile output + deployment record — the compile report is read from here. */
  compiledOutputDirectory: string;
  /** Parent directory under which `runs/<run_id>/` is assembled. */
  runsRootDirectory: string;
  /** The floor network the operator seed is posted into. */
  seedNetworkId?: string;
  seedRoomId?: string;
  /** The representative agent the seed @mentions to wake it. */
  seedTargetAgentId?: string;
  seedMessageText?: string;
  /** Substring the representative's floor-facing SYNTHESIS carries — the run's completion gate. */
  synthesisMarker?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  removeVolumesOnDown?: boolean;
  now?: () => Date;
}

export interface RunComposedJungianSimResult {
  runDir: string;
  runId: string;
  /** The representative's floor-facing synthesis message text (proof the whole membrane chain closed). */
  synthesis: string;
}

const DEFAULT_SEED_NETWORK = "psyche-floor";
const DEFAULT_SEED_ROOM = "commons";
const DEFAULT_SEED_TARGET = "luna-representative";
const DEFAULT_SEED_TEXT =
  "@luna-representative The floor asks: how should Luna meet the coming change?";
const DEFAULT_SYNTHESIS_MARKER = "council has spoken";
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** One managed Moltnet network the compile report declares: its id, host-reachable base url, and each room's declared members. */
interface NetworkPlan {
  networkId: string;
  baseUrl: string;
  rooms: { roomId: string; members: string[] }[];
}

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * Reads `spawnfile-report.json` and extracts the managed networks: id,
 * base url (host-published 1:1), and per-room membership. This is the driver's
 * ONE structured read of the compile report — everything else is HTTP polling.
 */
const readNetworkPlans = async (compiledOutputDirectory: string): Promise<NetworkPlan[]> => {
  const raw = await readFile(path.join(compiledOutputDirectory, "spawnfile-report.json"), "utf8");
  const report = JSON.parse(raw) as {
    container?: { moltnet?: { server_plans?: unknown } };
  };
  const plans = Array.isArray(report.container?.moltnet?.server_plans)
    ? (report.container!.moltnet!.server_plans as Record<string, unknown>[])
    : [];
  const networks: NetworkPlan[] = [];
  for (const plan of plans) {
    if (asString(plan.mode) !== "managed") continue;
    const networkId = asString(plan.network_id);
    const baseUrl = asString(plan.base_url);
    if (!networkId || !baseUrl) continue;
    const rooms = Array.isArray(plan.rooms) ? (plan.rooms as Record<string, unknown>[]) : [];
    networks.push({
      networkId,
      baseUrl,
      rooms: rooms
        .map((room) => ({
          roomId: asString(room.id),
          members: Array.isArray(room.members) ? room.members.filter((m): m is string => typeof m === "string") : []
        }))
        .filter((room): room is { roomId: string; members: string[] } => room.roomId !== undefined)
    });
  }
  return networks;
};

/** Waits until EVERY managed network is healthy and every declared room member has a live, connected bridge — the precondition for a single seed to reach the whole psyche. */
const waitForPsycheReady = async (networks: readonly NetworkPlan[], poll: PollOptions): Promise<void> => {
  for (const network of networks) {
    await pollUntilReady(`moltnet ${network.networkId} health`, poll, async () =>
      (await moltnetHealthy(network.baseUrl)) ? true : null
    );
    for (const room of network.rooms) {
      await pollUntilReady(`${network.networkId}:${room.roomId} membership`, poll, async () => {
        const summary = await getMoltnetRoom(network.baseUrl, room.roomId);
        const expected = [...room.members].sort();
        const actual = [...summary.members].sort();
        return expected.length === actual.length && expected.every((id, i) => actual[i] === id) ? summary : null;
      });
      await pollUntilReady(`${network.networkId}:${room.roomId} bridges`, poll, async () => {
        const agents = await listMoltnetAgents(network.baseUrl);
        return allMembersConnected(agents, room.roomId, room.members) ? agents : null;
      });
    }
  }
};

const buildSeedEvent = (networkId: string, roomId: string, targetAgentId: string, text: string): RuntimeTraceEvent => ({
  event_id: `seed-${Date.now()}`,
  kind: "world.message",
  target: `room:${networkId}:${roomId}`,
  sim_time: 0,
  provenance: "external",
  actor: `operator:${targetAgentId}`,
  scope: "global",
  payload: { content: text }
});

const messageText = (message: { parts: { kind: string; text?: string }[] }): string =>
  message.parts.find((part) => part.kind === "text")?.text ?? "";

/** Writes one per-network room transcript to `raw/moltnet/<networkId>/transcript.json` and returns its manifest artifact entry. */
const writeNetworkTranscript = async (
  runDir: string,
  network: NetworkPlan
): Promise<RunManifestArtifactEntry> => {
  const transcript = await exportMoltnetTranscript({
    baseUrl: network.baseUrl,
    targets: network.rooms.map((room) => roomTranscriptTargetFromScope(`room:${network.networkId}:${room.roomId}`))
  });
  const relativePath = path.posix.join("raw", "moltnet", network.networkId, "transcript.json");
  const absolutePath = path.join(runDir, "raw", "moltnet", network.networkId, "transcript.json");
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const content = `${JSON.stringify(transcript, null, 2)}\n`;
  await writeFile(absolutePath, content, "utf8");
  return { path: relativePath, sha256: sha256HexOfBuffer(Buffer.from(content, "utf8")) };
};

/** Copies the compile report into the run-dir (the viewer's named feed #1, source of the derived membranes) and returns its artifact entry. */
const copyCompileReport = async (
  runDir: string,
  compiledOutputDirectory: string
): Promise<RunManifestArtifactEntry> => {
  const source = path.join(compiledOutputDirectory, "spawnfile-report.json");
  const destination = path.join(runDir, "spawnfile-report.json");
  await copyFile(source, destination);
  const content = await readFile(destination);
  return { path: "spawnfile-report.json", sha256: sha256HexOfBuffer(content) };
};

/**
 * Runs the composed jungian psyche end to end: up -> poll every network ready
 * -> seed the floor ONCE -> wait for the representative's synthesis to reappear
 * on the floor (proof the interior council deliberated and answered across the
 * membrane) -> export per-network transcripts + causal artifacts + the compile
 * report -> down -> write `manifest.json` (with `world.rooms[]`) LAST.
 */
export const runComposedJungianSim = async (
  options: RunComposedJungianSimOptions
): Promise<RunComposedJungianSimResult> => {
  const cli: SpawnfileCliContext = { spawnfileBin: options.spawnfileBin };
  const seedNetworkId = options.seedNetworkId ?? DEFAULT_SEED_NETWORK;
  const seedRoomId = options.seedRoomId ?? DEFAULT_SEED_ROOM;
  const seedTargetAgentId = options.seedTargetAgentId ?? DEFAULT_SEED_TARGET;
  const seedMessageText = options.seedMessageText ?? DEFAULT_SEED_TEXT;
  const synthesisMarker = options.synthesisMarker ?? DEFAULT_SYNTHESIS_MARKER;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const poll: PollOptions = {
    intervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    sleep: defaultSleep,
    timeoutMs
  };
  const now = options.now ?? (() => new Date());

  const upReceipt = await runSpawnfileUp(cli, {
    orgPath: options.orgPath,
    containerName: options.containerName,
    deploymentName: options.deploymentName,
    compiledOutputDirectory: options.compiledOutputDirectory
  });
  if (!upReceipt.run_id) {
    throw new Error("spawnfile up-receipt had no run_id; cannot assemble a run directory");
  }

  const runId = upReceipt.run_id;
  const runDir = path.join(options.runsRootDirectory, runId);
  const networks = await readNetworkPlans(options.compiledOutputDirectory);
  const seedNetwork = networks.find((network) => network.networkId === seedNetworkId);
  if (!seedNetwork) {
    throw new Error(`seed network ${seedNetworkId} not found in compile report`);
  }

  let synthesis: string;
  try {
    await waitForPsycheReady(networks, poll);

    // The ONE write this driver performs — everything else is a read.
    await sendWorldEventToMoltnet(buildSeedEvent(seedNetworkId, seedRoomId, seedTargetAgentId, seedMessageText), {
      baseUrl: seedNetwork.baseUrl,
      networkId: seedNetworkId
    });

    // Completion = the representative's floor-facing synthesis appears. It can
    // only exist AFTER the representative was woken by the council's conclusion
    // inside the inner network, which itself required the representative to have
    // first crossed the membrane inward — so this single condition proves the
    // whole wake-across-membranes chain closed.
    const synthesisMessage = await pollUntilReady("representative synthesis on the floor", poll, async () => {
      const messages = await listMoltnetRoomMessages(seedNetwork.baseUrl, seedRoomId, 200);
      return (
        messages.find(
          (message) => message.from.id === seedTargetAgentId && messageText(message).includes(synthesisMarker)
        ) ?? null
      );
    });
    synthesis = messageText(synthesisMessage);

    const exportResult = await runSpawnfileArtifactsExport(cli, {
      orgPath: options.orgPath,
      deploymentName: options.deploymentName,
      compiledOutputDirectory: options.compiledOutputDirectory,
      destinationDirectory: runDir
    });

    // Per-network transcripts + compile report, fetched/copied while the
    // deployment is still live (transcripts need the running Moltnet HTTP API).
    const transcriptArtifacts = await Promise.all(networks.map((network) => writeNetworkTranscript(runDir, network)));
    const reportArtifact = await copyCompileReport(runDir, options.compiledOutputDirectory);

    await runSpawnfileDown(cli, {
      orgPath: options.orgPath,
      deploymentName: options.deploymentName,
      compiledOutputDirectory: options.compiledOutputDirectory,
      removeVolumes: options.removeVolumesOnDown ?? true
    });

    const world = {
      rooms: networks.flatMap((network) =>
        network.rooms.map((room) => ({
          network_id: network.networkId,
          room_id: room.roomId,
          members: [...room.members].sort()
        }))
      )
    };
    const manifest = composeRunManifest({
      runId,
      createdAt: now().toISOString(),
      fingerprint: upReceipt.fingerprint,
      engine: [...new Set((upReceipt.engines ?? []).map((entry) => entry.engine))].sort().join("+") || "unknown",
      world,
      exportedArtifacts: exportResult.index.files,
      extraArtifacts: [...transcriptArtifacts, reportArtifact]
    });
    await writeFile(path.join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } catch (error) {
    await runSpawnfileDown(cli, {
      orgPath: options.orgPath,
      deploymentName: options.deploymentName,
      compiledOutputDirectory: options.compiledOutputDirectory,
      removeVolumes: options.removeVolumesOnDown ?? true
    }).catch(() => undefined);
    throw error;
  }

  return { runDir, runId, synthesis };
};
