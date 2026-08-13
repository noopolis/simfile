import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { access, readFile } from "node:fs/promises";
import { basename, dirname, resolve, join } from "node:path";

import { readRunFrames } from "./runFrames.js";
import { loadRunLiveBundle } from "./runLiveBundle.js";
import { readLiveWorld, sendRunFrames } from "./runLiveFollow.js";
import { sendViewerEvents } from "./events.js";
import { readPlaybackDiagnostics } from "./playbackDiagnostics.js";
import {
  viewerExtensionIndex,
  type ViewerExtensionMount,
} from "./viewerExtensions.js";
import {
  streamViewerExtensionFile,
  streamViewerFile,
} from "./viewerAssets.js";
import { buildViewerState } from "./viewerState.js";
import type { RunViewerExtensionIdentity } from "./runViewerExtensions.js";
import { startRunSealFollower, type RunSealFollowerState } from "./runSealFollower.js";
import {
  loadRunReplayBundle,
  runReplayMetaResponse,
  type RunReplayBundle,
} from "./runReplayBundle.js";

export interface ViewerServerConfig {
  extensions?: readonly ViewerExtensionMount[];
  port: number;
  sourcePath: string;
  statePath?: string;
  mode: "live" | "replay";
  recordedViewerExtensions?: "ignored";
  extensionIdentities?: readonly RunViewerExtensionIdentity[];
  reconcileViewerExtensionsAtSeal?: () => Promise<readonly RunViewerExtensionIdentity[]>;
}

export interface ViewerServerHandle {
  awaitSeal: () => Promise<RunSealFollowerState>;
  close: () => Promise<void>;
  url: string;
}

const replayRequiredArtifacts = ["manifest.yaml", "viewer-trace.json"] as const;

const sendJson = (res: ServerResponse, body: unknown, status = 200): void => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

const recordedWorldResponse = (replay: RunReplayBundle): Record<string, unknown> => ({
  now: replay.model.createdAt,
  run_id: replay.world.run_id,
  run_name: replay.world.run_name,
  trace: replay.world,
});

const sendState = (
  req: IncomingMessage,
  res: ServerResponse,
  config: ViewerServerConfig,
  effectiveMode: ViewerServerConfig["mode"] | "run-replay" | "run-live",
): void => {
  if (req.url === undefined) return;
  sendJson(res, buildViewerState(config, effectiveMode));
};

const sendSkins = (_req: IncomingMessage, res: ServerResponse): void => {
  sendJson(res, {
    selected: "default",
    options: [
      { id: "default", label: "Default (No Skin)" },
      { id: "office", label: "Office Floor" },
      { id: "night", label: "Night Shift" },
    ],
  });
};

const loadViewerTrace = async (path: string): Promise<Record<string, unknown> | null> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

type ReplayRequiredArtifact = (typeof replayRequiredArtifacts)[number];

const resolveReplayArtifacts = async (basePath: string): Promise<string[]> => {
  const base = resolve(basePath);
  const missing = await Promise.all(
    replayRequiredArtifacts.map(async (artifact: ReplayRequiredArtifact): Promise<ReplayRequiredArtifact | undefined> => {
      try {
        await access(join(base, artifact));
        return undefined;
      } catch {
        return artifact;
      }
    }),
  );
  return missing.filter((artifact): artifact is ReplayRequiredArtifact => artifact !== undefined);
};

const isViewerTrace = (value: Record<string, unknown> | null): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const sendWorld = async (_req: IncomingMessage, res: ServerResponse, config: ViewerServerConfig): Promise<void> => {
  const sourcePath = resolve(config.statePath ?? config.sourcePath);
  if (config.mode === "replay") {
    const missingArtifacts = await resolveReplayArtifacts(sourcePath);
    if (missingArtifacts.length > 0) {
      sendJson(res, {
        error: "viewer-trace.json requires a sealed replay directory",
        mode: "replay",
        source_path: sourcePath,
        required_artifacts: [...replayRequiredArtifacts],
        missing_artifacts: missingArtifacts,
      }, 404);
      return;
    }
  }

  const trace = await loadViewerTrace(join(sourcePath, "viewer-trace.json"));
  if (!isViewerTrace(trace)) {
    sendJson(res, { error: "viewer-trace.json not found" }, 404);
    return;
  }
  sendJson(res, {
    now: new Date().toISOString(),
    run_id: trace.run_id,
    run_name: trace.run_name,
    trace
  });
};

const sendEvents = async (_req: IncomingMessage, res: ServerResponse, config: ViewerServerConfig): Promise<void> => {
  const tracePath = join(resolve(config.statePath ?? config.sourcePath), "viewer-trace.json");
  await sendViewerEvents(res, tracePath, config.mode);
};

export const createViewerServer = async (config: ViewerServerConfig): Promise<ViewerServerHandle> => {
  const initialRunReplay = await loadRunReplayBundle(config);
  const runLive = initialRunReplay === null ? await loadRunLiveBundle(config) : null;
  const extensions = config.extensions ?? [];
  const extensionById = new Map(extensions.map((extension) =>
    [extension.id, extension] as const));
  let latestPlaybackDiagnostics: Record<string, number | boolean> | null = null;
  let playbackDiagnosticsReceivedAt: string | null = null;
  const sealFollower = runLive === null ? undefined : startRunSealFollower({
    initialIdentities: config.extensionIdentities,
    reconcileAtSeal: config.reconcileViewerExtensionsAtSeal,
    runDir: resolve(config.sourcePath),
  });
  const extensionState = () => sealFollower?.getState() ?? {
    identities: config.extensionIdentities ?? [],
    status: "recorded" as const,
  };
  let sealedRunReplay: RunReplayBundle | null = null;
  let sealedRunReplayPromise: Promise<RunReplayBundle> | null = null;
  const loadSealedRunReplay = (): Promise<RunReplayBundle> => {
    if (initialRunReplay !== null) return Promise.resolve(initialRunReplay);
    if (sealedRunReplay !== null) return Promise.resolve(sealedRunReplay);
    if (sealedRunReplayPromise !== null) return sealedRunReplayPromise;
    const seal = extensionState();
    if (seal.status !== "recorded") {
      return Promise.reject(new Error("run has not sealed"));
    }
    sealedRunReplayPromise = loadRunReplayBundle({
      ...config,
      extensionIdentities: seal.identities,
    }).then((bundle) => {
      if (bundle === null) throw new Error("sealed run replay is unavailable");
      sealedRunReplay = bundle;
      return bundle;
    }).finally(() => {
      sealedRunReplayPromise = null;
    });
    return sealedRunReplayPromise;
  };

  const server: Server = createServer(async (req, res) => {
    const path = req.url?.split("?")[0] ?? "/";

    if (path === "/api/state") {
      const sealed = runLive !== null && extensionState().status === "recorded";
      sendState(req, res, config,
        initialRunReplay || sealed ? "run-replay" : runLive ? "run-live" : config.mode);
      return;
    }

    if (path === "/api/skins") {
      sendSkins(req, res);
      return;
    }

    if (path === "/api/viewer-extensions") {
      sendJson(res, viewerExtensionIndex(extensions));
      return;
    }

    const extensionMatch = /^\/_simfile\/viewer-extensions\/([a-z][a-z0-9-]{0,63})\/(module\.js|assets(?:\/(.*))?)$/u.exec(path);
    if (extensionMatch) {
      const seal = extensionState();
      if (seal.status === "failed") {
        sendJson(res, {
          error: "viewer extension identity reconciliation failed closed",
          reason: seal.error,
        }, 409);
        return;
      }
      const extension = extensionById.get(extensionMatch[1]!);
      if (extension === undefined) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      if (extensionMatch[2] === "module.js") {
        await streamViewerExtensionFile(
          res,
          dirname(extension.modulePath),
          basename(extension.modulePath),
          extension.moduleSha256,
        );
        return;
      }
      if (extension.assetRoot !== undefined && extensionMatch[3]) {
        const expected = extension.assetFiles[extensionMatch[3]];
        if (expected === undefined) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
          return;
        }
        await streamViewerExtensionFile(
          res,
          extension.assetRoot,
          extensionMatch[3],
          expected,
        );
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    if (path === "/api/playback-diagnostics" && req.method === "GET") {
      sendJson(res, {
        diagnostics: latestPlaybackDiagnostics,
        received_at: playbackDiagnosticsReceivedAt,
      });
      return;
    }

    if (path === "/api/playback-diagnostics" && req.method === "POST") {
      try {
        latestPlaybackDiagnostics = await readPlaybackDiagnostics(req);
        playbackDiagnosticsReceivedAt = new Date().toISOString();
        res.writeHead(204);
        res.end();
      } catch {
        sendJson(res, { error: "invalid playback diagnostics" }, 400);
      }
      return;
    }

    if (path === "/api/run-lifecycle" && runLive !== null) {
      const seal = extensionState();
      if (seal.status === "failed") {
        sendJson(res, { error: seal.error }, 409);
        return;
      }
      if (seal.status === "live") {
        sendJson(res, { error: "run has not sealed" }, 409);
        return;
      }
      const replay = await loadSealedRunReplay();
      sendJson(res, {
        mode: "run-replay",
        timeline: replay.timeline,
        world: recordedWorldResponse(replay),
        runMeta: runReplayMetaResponse(replay),
      });
      return;
    }

    const runReplay = initialRunReplay
      ?? (runLive !== null && extensionState().status === "recorded"
        ? await loadSealedRunReplay()
        : null);
    if (runReplay) {
      if (path === "/api/timeline") {
        sendJson(res, runReplay.timeline);
        return;
      }
      if (path === "/api/world") {
        sendJson(res, recordedWorldResponse(runReplay));
        return;
      }
      if (path === "/api/run-meta") {
        sendJson(res, runReplayMetaResponse(runReplay));
        return;
      }
      // No `/api/events`: run-replay's cursor is scrubbed by the client
      // store, never a live/synthetic tick that would fight it.
      // No `/api/run-view-model.json`: retired in increment 2 — the React
      // shell's `RunMetaPanels` renders `/api/run-meta` (a subset of the
      // same computed model) instead of the bespoke `runPage.ts` page.
    } else if (runLive) {
      if (path === "/api/world") {
        const seal = extensionState();
        const dataDir = seal.status === "live"
          ? runLive.stagingDir
          : resolve(config.sourcePath);
        const trace = await readLiveWorld(
          dataDir,
          seal.identities,
          seal.status !== "live",
        );
        sendJson(res, { now: new Date().toISOString(), trace: { ...trace, run_id: undefined, run_name: undefined } });
        return;
      }
      if (path === "/api/run-meta") {
        const frames = await readRunFrames(runLive.stagingDir);
        sendJson(res, {
          live: true,
          notYetComputed: ["runId", "verdict", "provenance", "engineProvenance"],
          timing: frames?.timing,
          simSecondsPerTick: frames?.simSecondsPerTick,
        });
        return;
      }
      if (path === "/api/run-frames" && req.method === "GET") {
        await sendRunFrames(
          res,
          resolve(config.sourcePath),
          runLive.stagingDir,
          sealFollower,
        );
        return;
      }
    } else {
      if (path === "/api/world") {
        await sendWorld(req, res, config);
        return;
      }

      if (path === "/api/events") {
        await sendEvents(req, res, config);
        return;
      }
    }

    const assetPath = path === "/" || path === "/index.html" ? "index.html" : path.replace(/^\//, "");
    await streamViewerFile(res, assetPath);
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(config.port, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  const address = server.address();
  if (address === null || address === ":0" || typeof address === "string") {
    throw new Error("Unable to bind viewer server");
  }

  return {
    awaitSeal: () => sealFollower?.awaitTerminal() ?? Promise.resolve({
      identities: extensionState().identities,
      status: "recorded" as const,
    }),
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      sealFollower?.close();
      server.close((error) => {
        if (error) {
          rejectClose(error);
          return;
        }
        resolveClose();
      });
      server.closeAllConnections();
    }),
    url: `http://127.0.0.1:${address.port}`,
  };
};
