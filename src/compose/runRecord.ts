import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";

import { stableStringify } from "../ledger/stable.js";
import { parseRunManifest, type SimfileRunManifest } from "../observe/manifest.js";
import { dynamicsRunStagingPrefix } from "../run/dynamics-run-artifacts.js";

export const COMPOSED_RUN_INVENTORY_VERSION = "simfile.composed-run-inventory.v1" as const;
export const COMPOSED_ARTIFACT_ROLES = Object.freeze([
  "accepted-action", "action-result", "authority-export", "identity",
  "presentation", "probe", "provenance", "terminal", "world-checkpoint",
  "world-frame",
] as const);
export type ComposedArtifactRole = typeof COMPOSED_ARTIFACT_ROLES[number];

interface RecordIdentity {
  readonly contract_versions: Readonly<Record<string, string>>;
  readonly created_at: string;
  readonly run_id: string;
  readonly spawnfile?: SimfileRunManifest["spawnfile"];
  readonly world?: SimfileRunManifest["world"];
}
export interface ComposedRunArtifactInput {
  readonly bytes: Uint8Array;
  readonly path: string;
  readonly role: ComposedArtifactRole;
}
export interface ComposedRunRecord {
  readonly out_dir: string;
  readonly staging_dir: string;
  abort(): Promise<void>;
  seal(): Promise<Readonly<{ manifest: SimfileRunManifest; manifest_sha256: string;
    out_dir: string }>>;
  writeArtifact(input: ComposedRunArtifactInput): Promise<void>;
  writeArtifacts(inputs: readonly ComposedRunArtifactInput[]): Promise<void>;
}

const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");
const ordered = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const safeRelativePath = (value: string): string => {
  if (value.length < 1 || value.length > 4_096 || path.isAbsolute(value)
    || path.posix.normalize(value) !== value || value === "."
    || value.split("/").some((part) => part.length === 0 || part === "..")
    || value === "manifest.json" || value === "inventory.json") {
    throw new TypeError("composed artifact path is invalid");
  }
  return value;
};
const exactIdentity = (raw: RecordIdentity): RecordIdentity => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(raw.run_id)
    || !Number.isFinite(Date.parse(raw.created_at))) {
    throw new TypeError("composed run record identity is invalid");
  }
  return Object.freeze(raw);
};
const durableWrite = async (
  filePath: string,
  bytes: Uint8Array | string,
): Promise<void> => {
  const handle = await open(filePath, "wx", 0o600);
  const failures: unknown[] = [];
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (failure) { failures.push(failure); }
  try { await handle.close(); } catch (failure) { failures.push(failure); }
  if (failures.length === 0) return;
  try { await rm(filePath, { force: true }); } catch (failure) { failures.push(failure); }
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(
    failures,
    "composed artifact durable write failed; cleanup also failed",
  );
};
const syncDirectory = async (directory: string): Promise<void> => {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
};

class RunRecord implements ComposedRunRecord {
  readonly out_dir: string;
  readonly staging_dir: string;
  readonly #identity: RecordIdentity;
  readonly #artifacts = new Map<string, { role: ComposedArtifactRole; sha256: string }>();
  #sealed = false;
  constructor(outDir: string, stagingDir: string, identity: RecordIdentity) {
    this.out_dir = outDir; this.staging_dir = stagingDir; this.#identity = identity;
  }
  async writeArtifact(input: ComposedRunArtifactInput): Promise<void> {
    await this.writeArtifacts([input]);
  }
  async writeArtifacts(inputs: readonly ComposedRunArtifactInput[]): Promise<void> {
    if (this.#sealed) throw new TypeError("composed run record is sealed");
    const prepared = inputs.map((input) => ({ input,
      relative: safeRelativePath(input.path) }));
    const paths = prepared.map(({ relative }) => relative);
    if (prepared.length === 0 || new Set(paths).size !== paths.length
      || prepared.some(({ input, relative }) =>
        !(COMPOSED_ARTIFACT_ROLES as readonly string[]).includes(input.role)
        || this.#artifacts.has(relative) || input.bytes.byteLength > 1_073_741_824)) {
      throw new TypeError("composed artifact declaration is invalid");
    }
    const written: string[] = [];
    try {
      for (const { input, relative } of prepared) {
        const target = path.join(this.staging_dir, relative);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await durableWrite(target, input.bytes);
        written.push(target);
      }
    } catch (error) {
      const cleanup = await Promise.allSettled(
        written.map((target) => rm(target, { force: true })),
      );
      const cleanupFailures = cleanup.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []);
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          "composed artifact group write and rollback both failed",
        );
      }
      throw error;
    }
    for (const { input, relative } of prepared) {
      this.#artifacts.set(relative, { role: input.role, sha256: sha256(input.bytes) });
    }
  }
  async seal(): Promise<Readonly<{ manifest: SimfileRunManifest;
    manifest_sha256: string; out_dir: string }>> {
    if (this.#sealed) throw new TypeError("composed run record is sealed");
    const roles = new Set([...this.#artifacts.values()].map(({ role }) => role));
    const missing = COMPOSED_ARTIFACT_ROLES.filter((role) => !roles.has(role));
    if (missing.length > 0) {
      throw new TypeError(`composed run inventory is incomplete: ${missing.join(", ")}`);
    }
    const entries = [...this.#artifacts.entries()].sort(([left], [right]) => ordered(left, right));
    for (const [relative, expected] of entries) {
      if (sha256(await readFile(path.join(this.staging_dir, relative))) !== expected.sha256) {
        throw new TypeError(`composed run artifact changed before seal: ${relative}`);
      }
    }
    const inventoryBytes = `${stableStringify({
      artifacts: entries.map(([artifactPath, entry]) => ({
        path: artifactPath, role: entry.role, sha256: entry.sha256,
      })),
      run_id: this.#identity.run_id,
      version: COMPOSED_RUN_INVENTORY_VERSION,
    })}\n`;
    await durableWrite(path.join(this.staging_dir, "inventory.json"), inventoryBytes);
    const artifacts = [
      ...entries.map(([artifactPath, entry]) => ({ path: artifactPath, sha256: entry.sha256 })),
      { path: "inventory.json", sha256: sha256(inventoryBytes) },
    ].sort((left, right) => ordered(left.path, right.path));
    const manifest = parseRunManifest({
      artifacts,
      contract_versions: {
        ...this.#identity.contract_versions,
        [COMPOSED_RUN_INVENTORY_VERSION]: COMPOSED_RUN_INVENTORY_VERSION,
        "simfile.run-manifest.v1": "simfile.run-manifest.v1",
      },
      created_at: this.#identity.created_at,
      run_id: this.#identity.run_id,
      ...(this.#identity.spawnfile === undefined ? {} : { spawnfile: this.#identity.spawnfile }),
      version: "simfile.run-manifest.v1",
      ...(this.#identity.world === undefined ? {} : { world: this.#identity.world }),
    });
    const manifestBytes = `${stableStringify(manifest)}\n`;
    await durableWrite(path.join(this.staging_dir, "manifest.json"), manifestBytes);
    await syncDirectory(this.staging_dir);
    await rename(this.staging_dir, this.out_dir);
    await syncDirectory(path.dirname(this.out_dir));
    this.#sealed = true;
    return Object.freeze({ manifest, manifest_sha256: sha256(manifestBytes), out_dir: this.out_dir });
  }
  async abort(): Promise<void> {
    if (this.#sealed) return;
    await rm(this.staging_dir, { force: true, recursive: true });
    await rmdir(this.out_dir).catch(() => undefined);
  }
}

/** Reserves one output and creates the only live-follow staging directory. */
export const createComposedRunRecord = async (input: Readonly<{
  identity: RecordIdentity;
  out_dir: string;
}>): Promise<ComposedRunRecord> => {
  const outDir = path.resolve(input.out_dir);
  if (outDir === path.parse(outDir).root) throw new TypeError("composed output path is invalid");
  const identity = exactIdentity(input.identity);
  await mkdir(path.dirname(outDir), { recursive: true });
  await mkdir(outDir);
  try {
    const staging = await mkdtemp(path.join(path.dirname(outDir), dynamicsRunStagingPrefix(outDir)));
    return new RunRecord(outDir, staging, identity);
  } catch (error) {
    await rmdir(outDir).catch(() => undefined);
    throw error;
  }
};
