import type { ActionFeedRow } from "./actionFeed.js";
import type { ActionLogDeclaration } from "./actionLog.js";

export interface ActionNarrationRequest {
  readonly row: ActionFeedRow;
  readonly declaration?: ActionLogDeclaration;
}

export interface ActionNarration {
  readonly text: string;
  readonly note?: string;
  // TODO(B279): the public `ActionNarration` in src/viewer-extension/index.ts declares this
  // contract separately and does not yet carry `form`, so a fixture narrator cannot set it.
  // Adding the one optional field there is out of this lane's write scope; until it lands the
  // message form is reachable only by a narrator registered in-process (see the tests below).
  readonly form?: "record" | "message";
}

export type ActionNarrator = (
  request: ActionNarrationRequest,
) => ActionNarration | undefined;

interface RegisteredActionNarrator {
  readonly extensionId: string;
  readonly narrator: ActionNarrator;
}

const safeId = /^[a-z][a-z0-9-]{0,63}$/u;
const narrators: RegisteredActionNarrator[] = [];
const extensionIds = new Set<string>();

export function registerActionNarrator(
  extensionId: string,
  narrator: ActionNarrator,
): void {
  if (!safeId.test(extensionId) || extensionIds.has(extensionId)
    || typeof narrator !== "function") {
    throw new TypeError("invalid or duplicate action narrator registration");
  }
  extensionIds.add(extensionId);
  narrators.push({ extensionId, narrator });
}

/** The first healthy narrator that returns non-blank text claims the row. */
export function narrateAction(
  request: ActionNarrationRequest,
): ActionNarration | undefined {
  for (const { narrator } of narrators) {
    try {
      const narration = narrator(request);
      if (narration !== undefined && typeof narration.text === "string"
        && narration.text.trim().length > 0) return narration;
    } catch {
      // Fixture presentation is isolated from the generic viewer.
    }
  }
  return undefined;
}

/** Test isolation for the process-global viewer extension catalog. */
export function resetActionNarratorsForTests(): void {
  narrators.length = 0;
  extensionIds.clear();
}
