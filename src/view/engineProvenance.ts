/**
 * Engine provenance disclosure (honesty gap fix): a run-replay viewer must
 * never let a deterministic scripted screenplay be mistaken for live
 * agents. This module classifies each engine name a run declares — either
 * per-agent (from `spawnfile/up-receipt.json`'s `engines[]`, when the
 * run-dir carries one) or the single collapsed `manifest.engine` string —
 * into one of three per-entry buckets (`scripted` / `real-engine` /
 * `unknown`), then folds those into one overall `EngineProvenance.mode` the
 * viewer badges unmissably.
 *
 * Classification rule (never guess):
 * - `fake-*` or exactly `scripted` -> `scripted` (a canned, authored
 *   screenplay — deterministic, not emergent dialogue).
 * - A recognized real model engine name (`grok`, `codex`, `agy`, `claude`,
 *   matched as a whole word/hyphenated-prefix so `claude-sonnet-4.5` or
 *   `grok-4` still match) -> `real-engine`.
 * - Anything else, including an entirely absent engine field -> `unknown`.
 *   `unknown` NEVER collapses to `real-engine` — absence of disclosure is
 *   never treated as evidence of a real engine.
 *
 * Overall `mode` is the single per-entry classification when every entry
 * agrees, or `"mixed"` when entries disagree (e.g. one agent scripted,
 * another real — or a real name alongside an undetermined one). `"mixed"`
 * is itself a disclosure, not a suppressed detail.
 */

export type EngineClassification = "scripted" | "real-engine" | "unknown";

export interface EngineEntry {
  /** Present when derived from a per-agent up-receipt `engines[]` row; absent for a single collapsed `manifest.engine` string. */
  agent?: string;
  engine: string;
}

export interface EngineProvenance {
  mode: EngineClassification | "mixed";
  engines: EngineEntry[];
  label: string;
}

const SCRIPTED_PATTERN = /^fake-/iu;
const REAL_ENGINE_NAMES = ["grok", "codex", "agy", "claude"] as const;

/** Matches a real engine name as a whole segment (`grok`, `grok-4`, `claude-sonnet-4.5`) so a substring of an unrelated word never false-matches. */
const realEngineNameFrom = (engine: string): string | undefined => {
  const lowered = engine.toLowerCase();
  return REAL_ENGINE_NAMES.find(
    (name) => lowered === name || lowered.startsWith(`${name}-`) || lowered.startsWith(`${name}_`)
  );
};

/** Classifies one engine name string. Exported for direct testing of the rule in isolation from the aggregation below. */
export const classifyEngineName = (engine: string): EngineClassification => {
  const lowered = engine.trim().toLowerCase();
  if (lowered === "scripted" || SCRIPTED_PATTERN.test(lowered)) return "scripted";
  if (realEngineNameFrom(lowered)) return "real-engine";
  return "unknown";
};

const SCRIPTED_LABEL = "⚙ SCRIPTED RUN — authored screenplay, not emergent dialogue (deterministic, not live agents)";
const UNKNOWN_LABEL = "❓ ENGINE UNKNOWN — provenance not disclosed, do not assume real agents";

const realEngineLabel = (engines: readonly EngineEntry[]): string => {
  const names = [...new Set(engines.map((entry) => entry.engine))];
  return `🧠 REAL ENGINE · ${names.join(", ")}`;
};

const mixedLabel = (engines: readonly EngineEntry[]): string => {
  const parts = engines.map((entry) => {
    const classification = classifyEngineName(entry.engine);
    const tag = classification === "scripted" ? "scripted" : classification === "real-engine" ? `real: ${entry.engine}` : "unknown";
    return entry.agent ? `${entry.agent}: ${tag}` : tag;
  });
  return `◐ MIXED ENGINES — ${parts.join(", ")} (not uniformly real or scripted)`;
};

/**
 * Folds a list of engine entries (per-agent or a single collapsed entry)
 * into the one `EngineProvenance` the viewer badges. An empty list (no
 * engine field disclosed anywhere) is `"unknown"` — never defaulted to
 * real or scripted.
 */
export const computeEngineProvenance = (engines: readonly EngineEntry[]): EngineProvenance => {
  if (engines.length === 0) {
    return { mode: "unknown", engines: [], label: UNKNOWN_LABEL };
  }

  const classifications = new Set(engines.map((entry) => classifyEngineName(entry.engine)));

  if (classifications.size === 1) {
    const [mode] = classifications;
    if (mode === "scripted") return { mode, engines: [...engines], label: SCRIPTED_LABEL };
    if (mode === "real-engine") return { mode, engines: [...engines], label: realEngineLabel(engines) };
    return { mode: "unknown", engines: [...engines], label: UNKNOWN_LABEL };
  }

  return { mode: "mixed", engines: [...engines], label: mixedLabel(engines) };
};
