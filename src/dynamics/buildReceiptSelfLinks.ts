import { canonicalJson, compareUtf16, deepFreeze } from "./buildIdentity.js";

const fail = (message: string): never => { throw new Error(message); };

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/u;
const EXPECTED_KEYS = [
  "manager",
  "lockfile_version",
  "lock_sha256",
  "lock_entry_path",
  "package_name",
  "package_version",
  "package_manifest_sha256",
  "target"
] as const;

export interface DynamicsReceiptSelfLinkEntry {
  readonly manager: "npm";
  readonly lockfile_version: 3;
  readonly lock_sha256: string;
  readonly lock_entry_path: "node_modules/simfile";
  readonly package_name: "simfile";
  readonly package_version: string;
  readonly package_manifest_sha256: string;
  readonly target: "toolchain_authority_root";
}

const assertRecord = (value: unknown, label: string): Readonly<Record<string, unknown>> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label}: expected object`);
  return value as Readonly<Record<string, unknown>>;
};

const assertExactKeys = (value: unknown, label: string): void => {
  const actual = Object.keys(assertRecord(value, label)).sort(compareUtf16);
  const expected = [...EXPECTED_KEYS].sort(compareUtf16);
  if (actual.length !== expected.length) fail(`${label}: unexpected key count`);
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) fail(`${label}: unexpected field ${actual[index]}`);
  }
};

export const compareDynamicsReceiptSelfLinkEntries = (
  left: DynamicsReceiptSelfLinkEntry,
  right: DynamicsReceiptSelfLinkEntry
): number => compareUtf16(canonicalJson(left), canonicalJson(right));

const assertSelfLinkEntry = (entry: DynamicsReceiptSelfLinkEntry, label: string): void => {
  assertExactKeys(entry, label);
  if (entry.manager !== "npm") fail(`${label}.manager: expected npm`);
  if (entry.lockfile_version !== 3) fail(`${label}.lockfile_version: expected 3`);
  if (!SHA256_PATTERN.test(entry.lock_sha256)) fail(`${label}.lock_sha256: expected lowercase sha-256`);
  if (entry.lock_entry_path !== "node_modules/simfile") fail(`${label}.lock_entry_path: expected node_modules/simfile`);
  if (entry.package_name !== "simfile") fail(`${label}.package_name: expected simfile`);
  if (!VERSION_PATTERN.test(entry.package_version)) fail(`${label}.package_version: invalid package version`);
  if (!SHA256_PATTERN.test(entry.package_manifest_sha256)) {
    fail(`${label}.package_manifest_sha256: expected lowercase sha-256`);
  }
  if (entry.target !== "toolchain_authority_root") fail(`${label}.target: expected toolchain_authority_root`);
};

export const assertCanonicalSelfLinkEntries = (
  entries: readonly DynamicsReceiptSelfLinkEntry[]
): readonly DynamicsReceiptSelfLinkEntry[] => {
  if (entries.length > 1) fail("self-link entries: expected at most one entry");
  const sorted = [...entries].sort(compareDynamicsReceiptSelfLinkEntries);
  if (canonicalJson(sorted) !== canonicalJson(entries)) fail("self-link entries are not canonical");

  const seen = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) fail(`self-link entries[${index}]: expected entry`);
    assertSelfLinkEntry(entry, `self-link entries[${index}]`);
    const key = canonicalJson(entry);
    if (seen.has(key)) fail("self-link entries: duplicate entry");
    seen.add(key);
  }
  return deepFreeze(sorted);
};
