import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Memetics increment (b): the extra sealed-artifact reads `seedSpread.ts`'s
 * re-derivation needs, on top of what `causalStreams.ts`/`memoryBanks.ts`
 * already collect. Kept as its own I/O-only module (this folder's own rule:
 * `compute.ts`-style pure functions never touch the filesystem) so
 * `seedSpread.ts` stays a pure function of already-loaded data, matching
 * `memoryBanks.ts`/`causalStreams.ts`'s split.
 */

export interface SpreadTranscriptMessage {
  id: string;
  fromId?: string;
  text: string;
}

export interface SpreadMnemeEvent {
  id: string;
  type: string;
  agentId?: string;
  text: string;
}

const walkFiles = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
};

const messageText = (parts: readonly { kind?: string; text?: string }[] | undefined): string =>
  (parts ?? [])
    .filter((part) => part.kind === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join(" ");

interface RawExportedMessage {
  id?: string;
  from?: { id?: string };
  parts?: { kind?: string; text?: string }[];
}

/**
 * Reads every `transcript.json` under `<runDir>/raw/moltnet/**` (today a
 * single file; globbed so a future multi-network export nesting transcripts
 * per network/room still gets picked up) and flattens every conversation's
 * messages to `{id, fromId, text}`. Only the `moltnet.transcript-export.v1`
 * export shape (`{conversations:[{messages}]}`) is read here — the seed-spread
 * path only ever runs against a real composed/world-driven run, never the
 * hand-authored golden-fixture shape (which never carries `seed_declaration`).
 */
export const readSpreadTranscriptMessages = async (runDir: string): Promise<SpreadTranscriptMessage[]> => {
  const moltnetDir = path.join(runDir, "raw", "moltnet");
  const files = (await walkFiles(moltnetDir)).filter((file) => file.endsWith("transcript.json")).sort();

  const messages: SpreadTranscriptMessage[] = [];
  for (const file of files) {
    const raw = JSON.parse(await readFile(file, "utf8")) as { conversations?: { messages?: RawExportedMessage[] }[] };
    for (const conversation of raw.conversations ?? []) {
      for (const message of conversation.messages ?? []) {
        if (typeof message.id !== "string") continue;
        messages.push({ id: message.id, fromId: message.from?.id, text: messageText(message.parts) });
      }
    }
  }
  return messages;
};

interface RawMnemeEventLine {
  id?: string;
  type?: string;
  principal?: { agentId?: string };
  content?: { text?: string };
}

/** Skips a line that fails to parse rather than crashing the whole read —
 * these are diagnostic bank/tick artifacts, never the causal ledger itself. */
const parseJsonlLines = (text: string): unknown[] => {
  const parsed: unknown[] = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return parsed;
};

/**
 * Reads every mneme bank's `events.jsonl` (the write-side/interim signal —
 * same file `memoryBanks.ts` falls back to) into `{id, type, agentId, text}`,
 * keyed by bank directory name. Every field is read verbatim from the
 * sealed file; a malformed line is skipped rather than crashing the whole
 * read (mirrors this folder's "report, don't stitch" posture for a
 * diagnostic-only artifact).
 */
export const readSpreadMnemeEventsByBank = async (
  runDir: string
): Promise<Map<string, SpreadMnemeEvent[]>> => {
  const mnemeDir = path.join(runDir, "raw", "mneme");
  const bankDirs = await readdir(mnemeDir, { withFileTypes: true }).catch(() => []);

  const byBank = new Map<string, SpreadMnemeEvent[]>();
  for (const entry of bankDirs) {
    if (!entry.isDirectory()) continue;
    const text = await readFile(path.join(mnemeDir, entry.name, "events.jsonl"), "utf8").catch(() => null);
    if (text === null) continue;

    const events: SpreadMnemeEvent[] = [];
    for (const line of parseJsonlLines(text)) {
      const row = line as RawMnemeEventLine;
      if (typeof row.id !== "string" || typeof row.type !== "string") continue;
      events.push({ id: row.id, type: row.type, agentId: row.principal?.agentId, text: row.content?.text ?? "" });
    }
    byBank.set(entry.name, events);
  }
  return byBank;
};

/**
 * Reads `<runDir>/world/ingested-messages.jsonl` (note: NOT under `raw/` —
 * `worldLedgerWriter.ts`'s own diagnostic, one line per tick,
 * `{tick, message_ids}`) into a `message_id -> tick` map: the one exact,
 * non-wall-clock fact the live world loop recorded about when it folded a
 * given Moltnet message into the run. Absent entirely for a run that wasn't
 * world-driven (batch `composedOfficeSimDriver`-style runs never write this
 * file) — returns an empty map rather than failing.
 */
export const readTickByIngestedMessageId = async (runDir: string): Promise<Map<string, number>> => {
  const filePath = path.join(runDir, "world", "ingested-messages.jsonl");
  const text = await readFile(filePath, "utf8").catch(() => null);
  if (text === null) return new Map();

  const byMessageId = new Map<string, number>();
  for (const line of parseJsonlLines(text)) {
    const row = line as { tick?: number; message_ids?: unknown };
    if (typeof row.tick !== "number" || !Array.isArray(row.message_ids)) continue;
    for (const messageId of row.message_ids) {
      if (typeof messageId === "string" && !byMessageId.has(messageId)) {
        byMessageId.set(messageId, row.tick);
      }
    }
  }
  return byMessageId;
};
