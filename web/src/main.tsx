import { createRoot } from "react-dom/client";

import { SimfileViewerApp } from "./viewer/App.js";
import { RunReplayShell } from "./viewer/RunReplayShell.js";
import { loadViewerExtensions } from "./viewer/worldMapRendererCatalog.js";
import "./styles.css";

const instrumentedGlobal = globalThis as typeof globalThis & {
  __SIMFILE_PLAYBACK_DIAGNOSTICS__?: Record<string, number | boolean>;
  __glyphPerf?: {
    dom: number[];
    polys: number[];
    raster: number[];
  };
};
instrumentedGlobal.__glyphPerf ??= { dom: [], polys: [], raster: [] };
instrumentedGlobal.__SIMFILE_PLAYBACK_DIAGNOSTICS__ ??= {
  positionCommits: 0,
  positionFrames: 0,
};

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing #root element");
}

/**
 * Shell selection lives here, not in `App.tsx` (`AGENTS.md`: keep that file
 * from bloating). `/api/state.mode === "run-replay"` picks the hybrid
 * map/chat/minds/scrub shell for a compose-and-observe run directory;
 * every other mode (`live`, `replay`) keeps the existing world console
 * unchanged.
 */
const mount = async (): Promise<void> => {
  const reactRoot = createRoot(root);
  let mode: string | undefined;
  try {
    const state = await fetch("/api/state").then((response) => response.json() as Promise<{ mode?: string }>);
    mode = state.mode;
  } catch {
    // The default console remains available when state discovery fails.
  }
  await loadViewerExtensions();
  if (mode === "run-replay" || mode === "run-live") {
    reactRoot.render(<RunReplayShell />);
    return;
  }
  reactRoot.render(<SimfileViewerApp />);
};

void mount().catch((error: unknown) => {
  root.textContent = error instanceof Error
    ? `Viewer extension failed: ${error.message}`
    : "Viewer extension failed";
});
