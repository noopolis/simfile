import type { ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";

const livePollMs = 200;
const liveFrameMs = 50;
const replayTickMs = 2_500;

const readTrace = async (path: string): Promise<Record<string, unknown> | null> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

export const maxViewerTraceTick = (trace: Record<string, unknown> | null): number => {
  return viewerTraceTicks(trace).at(-1) ?? 0;
};

export const viewerTraceTicks = (trace: Record<string, unknown> | null): number[] => {
  const facts = Array.isArray(trace?.ledger_facts) ? trace.ledger_facts : [];
  const presence = Array.isArray(trace?.presence) ? trace.presence : [];
  const spatial = Array.isArray(trace?.spatial_samples) ? trace.spatial_samples : [];
  return [...new Set([...facts, ...presence, ...spatial].flatMap((entry) => {
    const tick = typeof entry === "object" && entry !== null
      ? (entry as { tick?: unknown }).tick
      : undefined;
    return typeof tick === "number" && Number.isSafeInteger(tick) && tick >= 0 ? [tick] : [];
  }))].sort((left, right) => left - right);
};

const openStream = (res: ServerResponse): ((payload: Record<string, unknown>) => void) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": viewer observer stream\n\n");
  return (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

export const sendViewerEvents = async (
  res: ServerResponse,
  tracePath: string,
  mode: "live" | "replay",
): Promise<void> => {
  const push = openStream(res);
  push({ type: "connected", at: new Date().toISOString() });
  if (mode === "replay") {
    const maxTick = Math.max(1, maxViewerTraceTick(await readTrace(tracePath)));
    let tick = 0;
    const timer = setInterval(() => {
      tick = tick >= maxTick ? 0 : tick + 1;
      push({ type: "sim.tick", tick, at: new Date().toISOString(), message: `tick ${tick}` });
    }, replayTickMs);
    res.on("close", () => clearInterval(timer));
    return;
  }

  const queued = new Set<number>();
  const pending: number[] = [];
  const initialTrace = await readTrace(tracePath);
  const initialTicks = viewerTraceTicks(initialTrace);
  for (const tick of initialTicks) queued.add(tick);
  push({
    type: "sim.tick",
    tick: initialTicks.at(-1) ?? 0,
    at: new Date().toISOString(),
    message: "initial state frontier",
  });
  if (
    initialTrace?.playback_status === "completed"
    || initialTrace?.playback_status === "failed"
  ) {
    return;
  }

  let polling = false;
  const poll = async (): Promise<void> => {
    if (polling || res.destroyed) return;
    polling = true;
    try {
      const ticks = viewerTraceTicks(await readTrace(tracePath));
      for (const tick of ticks.length === 0 ? [0] : ticks) {
        if (!queued.has(tick)) {
          queued.add(tick);
          pending.push(tick);
        }
      }
    } finally {
      polling = false;
    }
  };
  const pollTimer = setInterval(() => void poll(), livePollMs);
  const frameTimer = setInterval(() => {
    const tick = pending.shift();
    if (tick !== undefined) {
      push({ type: "sim.tick", tick, at: new Date().toISOString(), message: `state tick ${tick}` });
    }
  }, liveFrameMs);
  res.on("close", () => {
    clearInterval(pollTimer);
    clearInterval(frameTimer);
  });
};
