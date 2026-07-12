import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { dirname, resolve, relative, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isObserveRunDir } from "./runDetect.js";
import { buildRunViewModel } from "./runViewModel.js";
import type { RunViewModel } from "./runViewModelTypes.js";
import { buildRunTimeline } from "./runTimeline.js";
import type { RunTimeline } from "./runTimelineTypes.js";
import { buildRunWorldTrace } from "./runWorldTrace.js";
import type { RunWorldTrace } from "./runWorldTrace.js";

export interface ViewerServerConfig {
  port: number;
  sourcePath: string;
  statePath?: string;
  mode: "live" | "replay";
}

export interface ViewerServerHandle {
  close: () => Promise<void>;
  url: string;
}

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
};

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const webDistRoot = resolve(packageRoot, "web", "dist");
const webSourceRoot = resolve(packageRoot, "web");
const webRoot = existsSync(resolve(webDistRoot, "index.html")) ? webDistRoot : webSourceRoot;
const replayRequiredArtifacts = ["manifest.yaml", "viewer-trace.json"] as const;

const sendJson = (res: ServerResponse, body: unknown, status = 200): void => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

const safeJoin = (base: string, target: string): string => {
  const absolute = resolve(base, target);
  const rel = relative(base, absolute);
  if (rel.startsWith("..") || rel.includes("../")) {
    throw new Error("Invalid path");
  }
  return absolute;
};

const streamFile = async (res: ServerResponse, requestedPath: string): Promise<void> => {
  try {
    const path = safeJoin(webRoot, requestedPath);
    await access(path);
    const stats = await stat(path);
    if (stats.isDirectory()) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    const contentType = mimeTypes[extname(path)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    createReadStream(path).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
};

const sendState = (
  req: IncomingMessage,
  res: ServerResponse,
  config: ViewerServerConfig,
  effectiveMode: ViewerServerConfig["mode"] | "run-replay",
): void => {
  if (req.url === undefined) return;
  sendJson(res, {
    mode: effectiveMode,
    sourcePath: config.sourcePath,
    statePath: config.statePath,
    now: new Date().toISOString(),
  });
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

const maxTraceTick = (trace: Record<string, unknown> | null): number => {
  const facts = Array.isArray(trace?.ledger_facts) ? trace.ledger_facts : [];
  const presence = Array.isArray(trace?.presence) ? trace.presence : [];
  return [...facts, ...presence].reduce((max, entry) => {
    if (typeof entry === "object" && entry !== null && typeof (entry as { tick?: unknown }).tick === "number") {
      return Math.max(max, (entry as { tick: number }).tick);
    }
    return max;
  }, 0);
};

const sendEvents = async (_req: IncomingMessage, res: ServerResponse, config: ViewerServerConfig): Promise<void> => {
  const tracePath = join(resolve(config.statePath ?? config.sourcePath), "viewer-trace.json");
  const trace = await loadViewerTrace(tracePath);
  const maxTick = Math.max(1, maxTraceTick(trace));
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": viewer heartbeat stream\n\n");
  let tick = 0;

  const pushEvent = (payload: Record<string, unknown>): void => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  pushEvent({ type: "connected", at: new Date().toISOString() });
  const timer = setInterval(() => {
    tick = tick >= maxTick ? 0 : tick + 1;
    pushEvent({
      type: "sim.tick",
      tick,
      at: new Date().toISOString(),
      message: `tick ${tick}`,
    });
  }, 2500);

  const cleanup = (): void => {
    clearInterval(timer);
  };

  res.on("close", cleanup);
};

interface RunReplayBundle {
  model: RunViewModel;
  timeline: RunTimeline;
  world: RunWorldTrace;
}

/**
 * `simfile view <dir>` picks run-replay mode over the world/3D replay mode
 * purely from the run directory's shape: a sealed compose-and-observe run
 * directory (`manifest.json` @ `simfile.run-manifest.v1` +
 * `raw/moltnet/transcript.json`, see `runDetect.ts`) never has `--state`
 * set, so this only applies in replay mode. Built once at server start (the
 * run directory is sealed, not tailed) rather than per-request. This
 * REPLACES the old bespoke run-reader HTML routing: run-replay mode serves
 * the same React shell as world/live mode, fed by `/api/timeline` and the
 * `runWorldTrace` adapter's `/api/world`, instead of `runPage.ts`'s
 * dedicated page. `runPage.ts`/`runPageScript.ts`/`runPageStyles.ts` stay in
 * the tree (their retirement is a later increment) but are no longer wired
 * into this server.
 */
const loadRunReplay = async (config: ViewerServerConfig): Promise<RunReplayBundle | null> => {
  if (config.mode !== "replay" || config.statePath) return null;
  const runDir = resolve(config.sourcePath);
  if (!(await isObserveRunDir(runDir))) return null;

  const [model, timeline] = await Promise.all([buildRunViewModel(runDir), buildRunTimeline(runDir)]);
  const world = buildRunWorldTrace({
    runId: model.runId,
    runName: model.runId,
    world: model.world,
    timeline,
  });
  return { model, timeline, world };
};

export const createViewerServer = async (config: ViewerServerConfig): Promise<ViewerServerHandle> => {
  const runReplay = await loadRunReplay(config);

  const server: Server = createServer(async (req, res) => {
    const path = req.url?.split("?")[0] ?? "/";

    if (path === "/api/state") {
      sendState(req, res, config, runReplay ? "run-replay" : config.mode);
      return;
    }

    if (path === "/api/skins") {
      sendSkins(req, res);
      return;
    }

    if (runReplay) {
      if (path === "/api/timeline") {
        sendJson(res, runReplay.timeline);
        return;
      }
      if (path === "/api/world") {
        sendJson(res, {
          now: new Date().toISOString(),
          run_id: runReplay.world.run_id,
          run_name: runReplay.world.run_name,
          trace: runReplay.world,
        });
        return;
      }
      if (path === "/api/run-view-model.json") {
        sendJson(res, runReplay.model);
        return;
      }
      // No `/api/events`: run-replay's cursor is scrubbed by the client
      // store, never a live/synthetic tick that would fight it.
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
    await streamFile(res, assetPath);
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
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) {
          rejectClose(error);
          return;
        }
        resolveClose();
      });
    }),
    url: `http://127.0.0.1:${address.port}`,
  };
};
