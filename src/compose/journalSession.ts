import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { canonicalComposedJson } from "./json.js";
import { parseComposedPhaseJournal, type ComposedPhaseJournal } from "./journal.js";

interface FileIdentity { readonly dev: number; readonly ino: number }
interface Snapshot { readonly identity: FileIdentity; readonly journal: ComposedPhaseJournal }
export interface ComposedJournalSession {
  readonly path: string;
  assertCurrent(expected?: ComposedPhaseJournal): Promise<void>;
  current(): ComposedPhaseJournal;
  replace(expected: ComposedPhaseJournal, next: ComposedPhaseJournal): Promise<void>;
}
export interface ComposedJournalSessionOptions {
  readonly beforeReplaceCommit?: () => Promise<void> | void;
}
export interface ComposedJournalAuthorityExpectation {
  readonly authority_digest: string;
  readonly run_id: string;
}

const exactPath = (value: string): string => {
  if (!path.isAbsolute(value) || path.normalize(value) !== value
    || value === path.parse(value).root || Buffer.byteLength(value, "utf8") > 4_096) {
    throw new TypeError("composed journal path is invalid");
  }
  return value;
};
const expectedAuthority = (raw: unknown): ComposedJournalAuthorityExpectation => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype) {
    throw new TypeError("composed journal authority expectation is invalid");
  }
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join("\0") !== "authority_digest\0run_id"
    || typeof value.authority_digest !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(value.authority_digest)
    || typeof value.run_id !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.run_id)) {
    throw new TypeError("composed journal authority expectation is invalid");
  }
  return { authority_digest: value.authority_digest, run_id: value.run_id };
};
const identityMatches = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;
const owned = (uid: number): boolean => process.getuid === undefined || uid === process.getuid();
const exactDirectory = async (directory: string): Promise<void> => {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || !owned(info.uid)
    || (process.platform !== "win32" && (info.mode & 0o777) !== 0o700)) {
    throw new TypeError("composed journal directory is unsafe");
  }
};
const snapshot = async (target: string, expected?: FileIdentity): Promise<Snapshot> => {
  await exactDirectory(path.dirname(target));
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || !owned(before.uid)
    || before.size < 2 || before.size > 16_777_216
    || (process.platform !== "win32" && (before.mode & 0o777) !== 0o600)) {
    throw new TypeError("composed journal file is unsafe");
  }
  const identity = { dev: before.dev, ino: before.ino };
  if (expected !== undefined && !identityMatches(identity, expected)) {
    throw new TypeError("composed journal file identity changed");
  }
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (!identityMatches(identity, opened)) throw new TypeError("composed journal file changed");
    const journal = parseComposedPhaseJournal(JSON.parse(await file.readFile("utf8")) as unknown);
    const after = await lstat(target);
    if (!identityMatches(identity, after)) throw new TypeError("composed journal file changed");
    return { identity, journal };
  } finally {
    await file.close();
  }
};
const bytes = (journal: ComposedPhaseJournal): string => `${canonicalComposedJson(journal)}\n`;
const sameJournal = (left: ComposedPhaseJournal, right: ComposedPhaseJournal): boolean =>
  left.journal_digest === right.journal_digest && left.request_digest === right.request_digest
  && left.request.run_id === right.request.run_id && bytes(left) === bytes(right);
const syncDirectory = async (directory: string): Promise<void> => {
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
};

class Session implements ComposedJournalSession {
  readonly path: string;
  readonly #options: ComposedJournalSessionOptions;
  #snapshot: Snapshot;
  constructor(target: string, initial: Snapshot, options: ComposedJournalSessionOptions) {
    this.path = target; this.#snapshot = initial; this.#options = options;
  }
  current(): ComposedPhaseJournal { return this.#snapshot.journal; }
  async assertCurrent(expected = this.#snapshot.journal): Promise<void> {
    if (!sameJournal(expected, this.#snapshot.journal)) {
      throw new TypeError("composed journal session expectation changed");
    }
    const current = await snapshot(this.path, this.#snapshot.identity);
    if (!sameJournal(current.journal, expected)) throw new TypeError("composed journal bytes changed");
  }
  async replace(expected: ComposedPhaseJournal, rawNext: ComposedPhaseJournal): Promise<void> {
    const next = parseComposedPhaseJournal(rawNext);
    if (expected.request_digest !== next.request_digest
      || expected.request.run_id !== next.request.run_id) {
      throw new TypeError("composed journal replacement correlation changed");
    }
    await this.assertCurrent(expected);
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.pending`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes(next), "utf8"); await file.sync();
    } finally { await file.close(); }
    try {
      await this.#options.beforeReplaceCommit?.();
      await this.assertCurrent(expected);
      await rename(temporary, this.path);
      await syncDirectory(path.dirname(this.path));
      const current = await snapshot(this.path);
      if (!sameJournal(current.journal, next)) throw new TypeError("composed journal commit changed");
      this.#snapshot = current;
    } finally { await unlink(temporary).catch(() => undefined); }
  }
}

export const openComposedJournalSession = async (
  rawPath: string,
  rawExpected: ComposedJournalAuthorityExpectation,
  options: ComposedJournalSessionOptions = {},
): Promise<ComposedJournalSession> => {
  const target = exactPath(rawPath);
  const expected = expectedAuthority(rawExpected);
  const initial = await snapshot(target);
  if (initial.journal.authority_digest !== expected.authority_digest
    || initial.journal.request.run_id !== expected.run_id) {
    throw new TypeError("composed journal authority changed");
  }
  return new Session(target, initial, options);
};

export const createComposedJournalSession = async (
  rawPath: string,
  rawJournal: ComposedPhaseJournal,
  options: ComposedJournalSessionOptions = {},
): Promise<ComposedJournalSession> => {
  const target = exactPath(rawPath);
  const journal = parseComposedPhaseJournal(rawJournal);
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700); await exactDirectory(directory);
  const temporary = `${target}.${process.pid}.${randomUUID()}.pending`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(bytes(journal), "utf8"); await file.sync(); } finally { await file.close(); }
  try {
    await link(temporary, target);
    await unlink(temporary);
    await syncDirectory(directory);
    return new Session(target, await snapshot(target), options);
  } finally { await unlink(temporary).catch(() => undefined); }
};
