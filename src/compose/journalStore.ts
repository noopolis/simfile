import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { canonicalComposedJson } from "./json.js";
import type { ComposedPhaseJournal } from "./journalSchema.js";
import { parseComposedPhaseJournal } from "./journalValidation.js";

const exactJournalPath = (value: string): string => {
  if (!path.isAbsolute(value) || path.normalize(value) !== value
    || value === path.parse(value).root || Buffer.byteLength(value, "utf8") > 4_096) {
    throw new TypeError("composed journal path is invalid");
  }
  return value;
};

export const writeComposedPhaseJournal = async (
  journalPath: string,
  rawJournal: unknown,
): Promise<void> => {
  const target = exactJournalPath(journalPath);
  const journal = parseComposedPhaseJournal(rawJournal);
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${target}.${process.pid}.${randomUUID()}.pending`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${canonicalComposedJson(journal)}\n`, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  try { await rename(temporary, target); }
  finally { await unlink(temporary).catch(() => undefined); }
};

export const readComposedPhaseJournal = async (
  journalPath: string,
): Promise<ComposedPhaseJournal> => parseComposedPhaseJournal(
  JSON.parse(await readFile(exactJournalPath(journalPath), "utf8")) as unknown,
);
