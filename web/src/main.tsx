import { createRoot } from "react-dom/client";

import { SimfileViewerApp } from "./viewer/App.js";
import { RunReplayShell } from "./viewer/RunReplayShell.js";
import "./styles.css";

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
  try {
    const state = await fetch("/api/state").then((response) => response.json() as Promise<{ mode?: string }>);
    if (state.mode === "run-replay") {
      reactRoot.render(<RunReplayShell />);
      return;
    }
  } catch {
    // Fall through to the default world/live console below.
  }
  reactRoot.render(<SimfileViewerApp />);
};

void mount();
