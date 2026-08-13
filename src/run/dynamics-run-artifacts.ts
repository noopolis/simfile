import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  type FileHandle
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { stableStringify } from "../ledger/stable.js";
import type {
  RunManifestArtifactEntry,
  SimfileRunManifest
} from "../observe/manifest.js";
import {
  writeDynamicsRunActionReplay,
  type DynamicsRunActionReplayInput
} from "./dynamics-run-replay.js";
export type { DynamicsRunActionReplayInput } from "./dynamics-run-replay.js";
export interface DynamicsRunFileOperations {
  mkdir: typeof mkdir;
  mkdtemp: typeof mkdtemp;
  open: typeof open;
  readFile: typeof readFile;
  realpath: typeof realpath;
  rename: typeof rename;
  rm: typeof rm;
  rmdir: typeof rmdir;
}
export interface DynamicsRunArtifactWriterOptions {
  fileOperations?: DynamicsRunFileOperations;
  outDir: string;
  stagingParent?: string;
}
export interface OwnedScratchRoot {
  path: string;
  remove: () => Promise<void>;
}
export interface DynamicsRunSealOptions {
  evidenceArtifactPath: string;
  manifestFactory: (
    artifacts: readonly RunManifestArtifactEntry[]
  ) => SimfileRunManifest;
}
export interface DynamicsRunArtifactWriter {
  stagingRealPath: string;
  abort(): Promise<void>;
  appendJsonl(relativePath: DynamicsRunJsonlPath, value: unknown): Promise<void>;
  flush(): Promise<void>;
  seal(options: DynamicsRunSealOptions): Promise<{ outDir: string }>;
  writeActionReplay(input: DynamicsRunActionReplayInput): Promise<void>;
  writeBytes(relativePath: DynamicsRunBytesPath, value: Uint8Array): Promise<void>;
  writeJson(relativePath: DynamicsRunJsonPath, value: unknown): Promise<void>;
}
export type DynamicsRunBytesPath = "viewer-extensions.json";
export type DynamicsRunJsonlPath =
  | "raw/action-attempts.jsonl"
  | "raw/action-results.jsonl"
  | "raw/commitment-outcomes.jsonl"
  | "raw/frames.jsonl"
  | "raw/steps.jsonl"
  | "raw/world/action-refusals.jsonl"
  | "raw/world/perception.jsonl"
  | "raw/world/causal.jsonl";
export type DynamicsRunJsonPath =
  | "provenance.json"
  | "replay/action-stream.json"
  | "replay/final-session.json"
  | "replay/initial-session.json"
  | "summary.json";
export const dynamicsRunStagingPrefix = (outDir: string): string =>
  `.${basename(outDir)}.staging-`;
const JSONL_PATHS: readonly DynamicsRunJsonlPath[] = [
  "raw/action-attempts.jsonl",
  "raw/action-results.jsonl",
  "raw/commitment-outcomes.jsonl",
  "raw/frames.jsonl",
  "raw/steps.jsonl",
  "raw/world/action-refusals.jsonl",
  "raw/world/perception.jsonl",
  "raw/world/causal.jsonl"
];
const STATIC_PATHS: readonly string[] = [
  "dynamics/build-receipt.json",
  "provenance.json",
  "raw/action-attempts.jsonl",
  "raw/action-results.jsonl",
  "raw/commitment-outcomes.jsonl",
  "raw/frames.jsonl",
  "raw/steps.jsonl",
  "raw/world/action-refusals.jsonl",
  "raw/world/perception.jsonl",
  "raw/world/causal.jsonl",
  "replay/action-stream.json",
  "replay/final-session.json",
  "replay/initial-session.json",
  "summary.json",
  "viewer-extensions.json"
];
const DEFAULT_FILE_OPERATIONS: DynamicsRunFileOperations = {
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  rmdir
};
const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const codePointOrder = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const isCode = (value: unknown, code: string): boolean =>
  typeof value === "object"
  && value !== null
  && (value as { code?: unknown }).code === code;
const existingRunDirectoryError = async (
  operations: DynamicsRunFileOperations,
  outDir: string
): Promise<Error> => {
  try {
    const manifest = await operations.open(join(outDir, "manifest.json"), "r");
    await manifest.close();
    return new Error(`refusing to overwrite existing sealed run record: ${outDir}`);
  } catch (failure) {
    if (!isCode(failure, "ENOENT")) throw failure;
    const stagingPattern = `${dynamicsRunStagingPrefix(outDir)}*`;
    return new Error(
      `refusing to reuse unsealed run directory: ${outDir}; `
      + "it may be a crash-orphaned reservation; after confirming no run process "
      + `is active, remove this directory and matching ${stagingPattern} directories before retrying`
    );
  }
};
const closeHandle = async (handle: FileHandle): Promise<unknown[]> => {
  const failures: unknown[] = [];
  try {
    await handle.sync();
  } catch (failure) {
    failures.push(failure);
  }
  try {
    await handle.close();
  } catch (failure) {
    failures.push(failure);
  }
  return failures;
};
const durableWrite = async (
  operations: DynamicsRunFileOperations,
  target: string,
  content: string | Uint8Array
): Promise<void> => {
  const handle = await operations.open(target, "wx");
  let primary: unknown;
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (failure) {
    primary = failure;
  }
  let closeFailure: unknown;
  try {
    await handle.close();
  } catch (failure) {
    closeFailure = failure;
  }
  if (primary !== undefined && closeFailure !== undefined) {
    throw new AggregateError(
      [primary, closeFailure],
      "dynamics run artifact write and cleanup both failed"
    );
  }
  if (primary !== undefined) throw primary;
  if (closeFailure !== undefined) throw closeFailure;
};
class ArtifactWriter implements DynamicsRunArtifactWriter {
  readonly #handles: Partial<Record<DynamicsRunJsonlPath, FileHandle>>;
  readonly #dirtyHandles = new Set<FileHandle>();
  readonly #operations: DynamicsRunFileOperations;
  readonly #outDir: string;
  readonly #staging: string;
  readonly stagingRealPath: string;
  #closed = false;
  #sealed = false;
  constructor(
    options: DynamicsRunArtifactWriterOptions,
    staging: string,
    stagingRealPath: string,
    handles: Partial<Record<DynamicsRunJsonlPath, FileHandle>>
  ) {
    this.#handles = handles;
    this.#operations = options.fileOperations ?? DEFAULT_FILE_OPERATIONS;
    this.#outDir = options.outDir;
    this.#staging = staging;
    this.stagingRealPath = stagingRealPath;
  }
  async #closeHandles(): Promise<unknown[]> {
    if (this.#closed) return [];
    const failures: unknown[] = [];
    try {
      await this.flush();
    } catch (failure) {
      failures.push(failure);
    }
    this.#closed = true;
    for (const path of JSONL_PATHS) {
      const handle = this.#handles[path];
      if (handle) failures.push(...await closeHandle(handle));
    }
    return failures;
  }
  async appendJsonl(
    relativePath: DynamicsRunJsonlPath,
    value: unknown
  ): Promise<void> {
    if (this.#closed || this.#sealed) {
      throw new Error("dynamics run artifact writer is closed");
    }
    const handle = this.#handles[relativePath];
    if (!handle) throw new Error(`missing dynamics run handle: ${relativePath}`);
    await handle.appendFile(`${stableStringify(value)}\n`, "utf8");
    this.#dirtyHandles.add(handle);
  }
  async flush(): Promise<void> {
    if (this.#dirtyHandles.size === 0) return;
    for (const path of JSONL_PATHS) {
      const handle = this.#handles[path];
      if (handle && this.#dirtyHandles.has(handle)) await handle.sync();
    }
    this.#dirtyHandles.clear();
  }
  async writeActionReplay(input: DynamicsRunActionReplayInput): Promise<void> {
    if (this.#closed || this.#sealed) {
      throw new Error("dynamics run artifact writer is closed");
    }
    const attemptsPath: DynamicsRunJsonlPath = "raw/action-attempts.jsonl";
    const attemptsHandle = this.#handles[attemptsPath];
    if (!attemptsHandle) throw new Error("missing dynamics action attempts handle");
    await writeDynamicsRunActionReplay({
      attemptsHandle,
      input,
      openFile: this.#operations.open,
      stagingRoot: this.#staging
    });
  }
  async writeJson(relativePath: DynamicsRunJsonPath, value: unknown): Promise<void> {
    if (this.#sealed) throw new Error("dynamics run artifact writer is sealed");
    await durableWrite(
      this.#operations,
      join(this.#staging, relativePath),
      `${stableStringify(value)}\n`
    );
  }
  async writeBytes(
    relativePath: DynamicsRunBytesPath,
    value: Uint8Array
  ): Promise<void> {
    if (this.#sealed) throw new Error("dynamics run artifact writer is sealed");
    await durableWrite(
      this.#operations,
      join(this.#staging, relativePath),
      value
    );
  }
  async seal(options: DynamicsRunSealOptions): Promise<{ outDir: string }> {
    if (this.#sealed) throw new Error("dynamics run artifact writer is sealed");
    const closeFailures = await this.#closeHandles();
    if (closeFailures.length > 0) {
      throw new AggregateError(closeFailures, "failed to close dynamics run artifacts");
    }
    const relativePaths = [...STATIC_PATHS, options.evidenceArtifactPath]
      .sort(codePointOrder);
    const artifacts: RunManifestArtifactEntry[] = [];
    for (const relativePath of relativePaths) {
      const bytes = await this.#operations.readFile(join(this.#staging, relativePath));
      artifacts.push({ path: relativePath, sha256: sha256(bytes) });
    }
    const manifest = options.manifestFactory(artifacts);
    await durableWrite(
      this.#operations,
      join(this.#staging, "manifest.json"),
      `${stableStringify(manifest)}\n`
    );
    await this.#operations.rename(this.#staging, this.#outDir);
    this.#sealed = true;
    return { outDir: this.#outDir };
  }
  async abort(): Promise<void> {
    if (this.#sealed) return;
    const failures = await this.#closeHandles();
    try {
      await this.#operations.rm(this.#staging, { force: true, recursive: true });
    } catch (failure) {
      failures.push(failure);
    }
    try {
      await this.#operations.rmdir(this.#outDir);
    } catch (failure) {
      failures.push(failure);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "dynamics run artifact abort failed");
    }
  }
}
export const createOwnedScratchRoot = async (
  fileOperations: DynamicsRunFileOperations = DEFAULT_FILE_OPERATIONS
): Promise<OwnedScratchRoot> => {
  const parent = await fileOperations.realpath(tmpdir());
  const path = await fileOperations.mkdtemp(
    join(parent, "simfile-dynamics-run-scratch-")
  );
  return {
    path,
    remove: async () => fileOperations.rm(path, { force: true, recursive: true })
  };
};
export const createDynamicsRunArtifactWriter = async (
  options: DynamicsRunArtifactWriterOptions
): Promise<DynamicsRunArtifactWriter> => {
  const operations = options.fileOperations ?? DEFAULT_FILE_OPERATIONS;
  await operations.mkdir(dirname(options.outDir), { recursive: true });
  try {
    await operations.mkdir(options.outDir);
  } catch (failure) {
    if (isCode(failure, "EEXIST")) {
      throw await existingRunDirectoryError(operations, options.outDir);
    }
    throw failure;
  }
  let staging: string | undefined;
  const handles: Partial<Record<DynamicsRunJsonlPath, FileHandle>> = {};
  try {
    staging = await operations.mkdtemp(join(
      options.stagingParent ?? dirname(options.outDir),
      dynamicsRunStagingPrefix(options.outDir)
    ));
    const stagingRealPath = await operations.realpath(staging);
    await operations.mkdir(join(staging, "dynamics"), { recursive: true });
    await operations.mkdir(join(staging, "raw/world"), { recursive: true });
    await operations.mkdir(join(staging, "replay"), { recursive: true });
    for (const relativePath of JSONL_PATHS) {
      handles[relativePath] = await operations.open(
        join(staging, relativePath),
        "wx"
      );
    }
    return new ArtifactWriter(options, staging, stagingRealPath, handles);
  } catch (primary) {
    const cleanupFailures: unknown[] = [];
    for (const relativePath of JSONL_PATHS) {
      const handle = handles[relativePath];
      if (handle) cleanupFailures.push(...await closeHandle(handle));
    }
    if (staging !== undefined) {
      try {
        await operations.rm(staging, { force: true, recursive: true });
      } catch (failure) {
        cleanupFailures.push(failure);
      }
    }
    try {
      await operations.rmdir(options.outDir);
    } catch (failure) {
      cleanupFailures.push(failure);
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [primary, ...cleanupFailures],
        "dynamics run artifact construction and cleanup both failed"
      );
    }
    throw primary;
  }
};
