import type { ReactNode } from "react";

import type { ReplayPanel } from "../store/timeline.js";

export function ReplayPrimaryPane({
  activePanel,
  conversation,
  map,
  onSelect,
}: {
  activePanel: ReplayPanel;
  conversation: ReactNode;
  map: ReactNode;
  onSelect: (panel: ReplayPanel) => void;
}) {
  return (
    <div className="replay-primary">
      <nav aria-label="Replay view" className="replay-primary-tabs">
        {(["conversation", "map"] as const).map((panel) => (
          <button
            aria-pressed={activePanel === panel}
            className={activePanel === panel ? "is-active" : undefined}
            key={panel}
            onClick={() => onSelect(panel)}
            type="button"
          >
            {panel}
          </button>
        ))}
      </nav>
      <div className="replay-primary-content">
        {activePanel === "conversation" ? conversation : map}
      </div>
    </div>
  );
}
