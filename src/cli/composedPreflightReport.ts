import { createHash } from "node:crypto";
import { lstat, open, readFile } from "node:fs/promises";

import { canonicalComposedJson } from "../compose/json.js";
import {
  parseSpawnfileCompileReport,
  type SpawnfileCompileReport,
} from "./compiledOrganizationIdentity.js";

const sha256 = (bytes: string | Uint8Array): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const assertPrivateRegularFile = async (target: string): Promise<void> => {
  const metadata = await lstat(target);
  if (!metadata.isFile() || metadata.isSymbolicLink()
    || process.getuid?.() !== undefined && metadata.uid !== process.getuid!()
    || process.platform !== "win32" && (metadata.mode & 0o777) !== 0o600) {
    throw new TypeError("composed preflight compile report snapshot is unsafe");
  }
};

/** Creates the immutable, private authority copy before `spawnfile up` can rewrite its output. */
export const writePreflightCompileReport = async (
  target: string,
  raw: unknown,
): Promise<Readonly<{ digest: `sha256:${string}`; report: SpawnfileCompileReport }>> => {
  const report = parseSpawnfileCompileReport(raw);
  const bytes = canonicalComposedJson(raw);
  const file = await open(target, "wx", 0o600);
  try { await file.writeFile(bytes, "utf8"); await file.sync(); }
  finally { await file.close(); }
  await assertPrivateRegularFile(target);
  return Object.freeze({ digest: sha256(bytes), report });
};

/** Reads only the authority snapshot; the mutable compiled report is intentionally irrelevant. */
export const readPreflightCompileReport = async (
  target: string,
  expectedDigest: string,
): Promise<SpawnfileCompileReport> => {
  await assertPrivateRegularFile(target);
  const bytes = await readFile(target);
  if (sha256(bytes) !== expectedDigest) {
    throw new TypeError("composed preflight compile report snapshot changed");
  }
  try { return parseSpawnfileCompileReport(JSON.parse(bytes.toString("utf8")) as unknown); }
  catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("composed preflight compile report snapshot is invalid");
  }
};

export const assertRecoverySourceDigests = (input: Readonly<{
  expected_simfile_digest: string;
  expected_spawnfile_digest: string;
  simfile_source: string;
  spawnfile_source: Uint8Array;
}>): void => {
  if (sha256(input.simfile_source) !== input.expected_simfile_digest
    || sha256(input.spawnfile_source) !== input.expected_spawnfile_digest) {
    throw new TypeError("composed bootstrap project source changed");
  }
};
