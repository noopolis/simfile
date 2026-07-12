import type { RunTimelineMembrane } from "../store/timeline.js";
import type { ViewerNode } from "./types.js";

/**
 * Synthesizes a "team" map node for each membrane, positioned just beside
 * its representative's own body — the outer map's descendable self
 * (`VIEW_DESIGN.md` rule 5: "the outer map should show the team:luna/
 * team:selene nodes as descendable membranes"). Presentation only: the
 * offset is a fixed constant, never invented per-run state, so two viewers
 * of the same run agree (replay determinism). A representative with no
 * matching node on the outer map (not yet rendered — no presence stream) is
 * skipped rather than guessing a position; this is why the function takes
 * the already-built node list instead of deriving positions itself.
 */

const MEMBRANE_NODE_OFFSET: [number, number] = [0.3, 0.24];

export const membraneMapNodes = (
  nodes: readonly ViewerNode[],
  membranes: readonly RunTimelineMembrane[],
): ViewerNode[] => {
  const extra: ViewerNode[] = [];
  for (const membrane of membranes) {
    const representativeNode = nodes.find((node) => node.scope === membrane.representative);
    if (!representativeNode) continue;
    extra.push({
      ...representativeNode,
      id: membrane.ref,
      label: membrane.label,
      kind: "team",
      scope: membrane.ref,
      subtitle: "descendable self",
      detail: `Interior of ${membrane.label} — click to descend into its council.`,
      scene: [
        representativeNode.scene[0] + MEMBRANE_NODE_OFFSET[0],
        representativeNode.scene[1] + MEMBRANE_NODE_OFFSET[1],
        representativeNode.scene[2],
      ],
    });
  }
  return extra;
};
