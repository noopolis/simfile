import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";

import type { TargetResourceReceipt } from "./targetReceipts.js";

const BLOCK_BYTES = 512;
const MAX_ARCHIVE_BYTES = 67_108_864;
const MAX_ENTRIES = 10_000;
const USTAR_MAGIC = Buffer.from("ustar\0", "ascii");
const USTAR_VERSION = Buffer.from("00", "ascii");
const SAFE_PATH = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;

type EvidenceIndex = NonNullable<TargetResourceReceipt["evidence_index"]>;
interface ArchiveFile {
  readonly bytes: Uint8Array;
  readonly path: string;
}
interface ParsedArchive {
  readonly directories: readonly string[];
  readonly files: readonly ArchiveFile[];
}

const fail = (): never => {
  throw new TypeError("Spawnfile world evidence archive is invalid");
};
const digest = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const zero = (bytes: Uint8Array): boolean => bytes.every((byte) => byte === 0);
const equal = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength
  && left.every((byte, index) => byte === right[index]);
const padded = (size: number): number => Math.ceil(size / BLOCK_BYTES) * BLOCK_BYTES;
const fieldText = (header: Uint8Array, offset: number, length: number): string => {
  const field = header.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  const content = nul < 0 ? field : field.subarray(0, nul);
  if (nul >= 0 && !zero(field.subarray(nul + 1))) return fail();
  const value = Buffer.from(content).toString("utf8");
  if (!Buffer.from(value, "utf8").equals(Buffer.from(content))) return fail();
  return value;
};
const octal = (header: Uint8Array, offset: number, length: number): number => {
  const field = header.subarray(offset, offset + length);
  if (field[length - 1] !== 0
    || !field.subarray(0, length - 1).every((byte) => byte >= 48 && byte <= 55)) {
    return fail();
  }
  const result = Number.parseInt(Buffer.from(field.subarray(0, length - 1)).toString("ascii"), 8);
  if (!Number.isSafeInteger(result) || result < 0) return fail();
  return result;
};
const checksum = (header: Uint8Array): number => {
  const field = header.subarray(148, 156);
  if (field[6] !== 0 || field[7] !== 0x20
    || !field.subarray(0, 6).every((byte) => byte >= 48 && byte <= 55)) return fail();
  return Number.parseInt(Buffer.from(field.subarray(0, 6)).toString("ascii"), 8);
};
const archivePath = (header: Uint8Array, directory: boolean): string => {
  const name = fieldText(header, 0, 100);
  const prefix = fieldText(header, 345, 155);
  const stored = prefix.length === 0 ? name : `${prefix}/${name}`;
  const value = directory && stored.endsWith("/") ? stored.slice(0, -1) : stored;
  if (value.length === 0 || value.endsWith("/") || !SAFE_PATH.test(value)
    || Buffer.byteLength(value, "utf8") > 255
    || value.split("/").some((part) => part === "." || part === "..")
    || directory !== stored.endsWith("/")) return fail();
  return value;
};
const conflicts = (
  files: ReadonlyMap<string, ArchiveFile>,
  directories: ReadonlySet<string>,
  candidate: string,
): boolean => files.has(candidate) || directories.has(candidate)
  || [...files.keys()].some((file) => candidate.startsWith(`${file}/`))
  || [...directories].some((directory) => directory.startsWith(`${candidate}/`));

const parseArchive = (archive: Uint8Array, index: EvidenceIndex): ParsedArchive => {
  if (archive.byteLength < BLOCK_BYTES * 2 || archive.byteLength > MAX_ARCHIVE_BYTES
    || archive.byteLength % BLOCK_BYTES !== 0 || digest(archive) !== index.evidence_digest) {
    return fail();
  }
  const files = new Map<string, ArchiveFile>();
  const directories = new Set<string>();
  let previousPath: string | undefined;
  let offset = 0;
  let entries = 0;
  while (offset < archive.byteLength) {
    const header = archive.subarray(offset, offset + BLOCK_BYTES);
    offset += BLOCK_BYTES;
    if (zero(header)) {
      if (entries === 0 || offset + BLOCK_BYTES !== archive.byteLength
        || !zero(archive.subarray(offset, offset + BLOCK_BYTES))) return fail();
      offset += BLOCK_BYTES;
      break;
    }
    if (++entries > MAX_ENTRIES
      || !equal(header.subarray(257, 263), USTAR_MAGIC)
      || !equal(header.subarray(263, 265), USTAR_VERSION)
      || !zero(header.subarray(157, 257))
      || fieldText(header, 265, 32) !== "" || fieldText(header, 297, 32) !== ""
      || octal(header, 108, 8) !== 0 || octal(header, 116, 8) !== 0
      || octal(header, 136, 12) !== 0 || octal(header, 329, 8) !== 0
      || octal(header, 337, 8) !== 0 || !zero(header.subarray(500, 512))) return fail();
    let actualChecksum = 0;
    for (let indexOffset = 0; indexOffset < BLOCK_BYTES; indexOffset += 1) {
      actualChecksum += indexOffset >= 148 && indexOffset < 156 ? 0x20 : header[indexOffset]!;
    }
    if (checksum(header) !== actualChecksum) return fail();
    const type = header[156];
    if (type !== 48 && type !== 53) return fail();
    const directory = type === 53;
    const entryPath = archivePath(header, directory);
    if (previousPath !== undefined
      && Buffer.compare(Buffer.from(previousPath), Buffer.from(entryPath)) >= 0) return fail();
    previousPath = entryPath;
    if (conflicts(files, directories, entryPath)) return fail();
    const size = octal(header, 124, 12);
    const mode = octal(header, 100, 8);
    if (directory ? size !== 0 || mode !== 0o755 : size > MAX_ARCHIVE_BYTES || mode !== 0o644) {
      return fail();
    }
    const dataEnd = offset + size;
    const paddedEnd = offset + padded(size);
    if (paddedEnd > archive.byteLength || !zero(archive.subarray(dataEnd, paddedEnd))) return fail();
    if (directory) directories.add(entryPath);
    else files.set(entryPath, Object.freeze({ bytes: archive.subarray(offset, dataEnd), path: entryPath }));
    offset = paddedEnd;
  }
  if (offset !== archive.byteLength || files.size !== index.files.length) return fail();
  for (const expected of index.files) {
    const file = files.get(expected.path);
    if (file === undefined || file.bytes.byteLength !== expected.bytes
      || digest(file.bytes) !== expected.sha256) return fail();
  }
  return Object.freeze({
    directories: Object.freeze([...directories]),
    files: Object.freeze([...files.values()]),
  });
};

const privateDirectory = async (directory: string): Promise<void> => {
  const info = await lstat(directory).catch(fail);
  const owner = process.getuid?.();
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700
    || owner !== undefined && info.uid !== owner || await realpath(directory).catch(fail) !== directory) {
    return fail();
  }
};
const readArchive = async (archivePathValue: string): Promise<Uint8Array> => {
  if (!path.isAbsolute(archivePathValue) || path.normalize(archivePathValue) !== archivePathValue
    || path.extname(archivePathValue) !== ".tar") return fail();
  await privateDirectory(path.dirname(archivePathValue));
  const handle = await open(archivePathValue, constants.O_RDONLY | constants.O_NOFOLLOW).catch(fail);
  try {
    const before = await handle.stat();
    const owner = process.getuid?.();
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || (before.mode & 0o777) !== 0o600 || before.size > MAX_ARCHIVE_BYTES
      || owner !== undefined && before.uid !== owner) return fail();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) return fail();
    return bytes;
  } finally {
    await handle.close();
  }
};

/** Validates the target's canonical USTAR export and atomically materializes private files. */
export const materializeWorldEvidenceArchive = async (input: Readonly<{
  archive_path: string;
  destination_directory: string;
  evidence_index: EvidenceIndex;
}>): Promise<void> => {
  const destination = input.destination_directory;
  if (!path.isAbsolute(destination) || path.normalize(destination) !== destination
    || destination === path.parse(destination).root) return fail();
  const parent = path.dirname(destination);
  await privateDirectory(parent);
  try {
    await lstat(destination);
    return fail();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const parsed = parseArchive(await readArchive(input.archive_path), input.evidence_index);
  const temporary = await mkdtemp(path.join(parent, `.${path.basename(destination)}.pending-`));
  await chmod(temporary, 0o700);
  let published = false;
  try {
    for (const directory of parsed.directories) {
      await mkdir(path.join(temporary, directory), { recursive: true, mode: 0o700 });
      await chmod(path.join(temporary, directory), 0o700);
    }
    for (const file of parsed.files) {
      const target = path.join(temporary, file.path);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const handle = await open(target, constants.O_CREAT | constants.O_EXCL
        | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(file.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await rename(temporary, destination);
    published = true;
  } finally {
    if (!published) await rm(temporary, { force: true, recursive: true });
  }
};
