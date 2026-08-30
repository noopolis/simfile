import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createComposedProjectBinding,
  type ComposedProjectBinding,
} from "../compose/index.js";
import { canonicalComposedJson } from "../compose/json.js";
import type { Simfile } from "../schema/index.js";

export interface LinkedSpawnfileSource {
  readonly bytes: Uint8Array;
  readonly path: string;
}

const sourceError = (): TypeError =>
  new TypeError("linked Spawnfile source must be a readable regular file");

/** Reads trusted local source bytes; later checks detect ordinary bootstrap drift. */
export const readLinkedSpawnfileSource = async (spawnfilePath: string): Promise<LinkedSpawnfileSource> => {
  try {
    if (!(await stat(spawnfilePath)).isFile()) throw sourceError();
    return Object.freeze({ bytes: await readFile(spawnfilePath), path: spawnfilePath });
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw sourceError();
  }
};

/** Detects deterministic source replacement, not the final filesystem syscall race. */
export const assertLinkedSpawnfileSourceUnchanged = async (source: LinkedSpawnfileSource): Promise<void> => {
  const current = await readLinkedSpawnfileSource(source.path);
  if (current.bytes.byteLength !== source.bytes.byteLength
    || !Buffer.from(current.bytes).equals(Buffer.from(source.bytes))) {
    throw new TypeError("linked Spawnfile source changed during composed bootstrap");
  }
};

/** Runs one bootstrap action while detecting ordinary linked-source drift before and after it. */
export const withUnchangedLinkedSpawnfileSource = async <Value>(
  source: LinkedSpawnfileSource,
  operation: () => Promise<Value>,
): Promise<Value> => {
  await assertLinkedSpawnfileSourceUnchanged(source);
  try { return await operation(); }
  finally { await assertLinkedSpawnfileSourceUnchanged(source); }
};

/** Loads trusted local code and applies the public wrapper's one validation pass. */
export const loadComposedProjectBinding = async (
  simfilePath: string,
  simfile: Simfile,
): Promise<ComposedProjectBinding> => {
  const reference = simfile.world_sidecar?.binding;
  if (reference === undefined) throw new TypeError("linked composed project has no binding");
  const modulePath = path.resolve(path.dirname(simfilePath), reference);
  const loaded = await import(pathToFileURL(modulePath).href) as Record<string, unknown>;
  const binding = loaded.composedProjectBinding as Partial<ComposedProjectBinding> | undefined;
  if (binding?.version !== "simfile.composed-project-binding.v1"
    || typeof binding.prepareComposedProject !== "function") {
    throw new TypeError("linked composed project binding is invalid");
  }
  return createComposedProjectBinding({
    prepareComposedProject: async (input) => binding.prepareComposedProject!(input),
  });
};

export const writePrivateComposedJson = async (target: string, value: unknown): Promise<void> => {
  await writeFile(target, canonicalComposedJson(value), { flag: "wx", mode: 0o600 });
};

/** Creates a private artifact once, or verifies exact canonical recovery bytes. */
export const writeOrVerifyPrivateComposedJson = async (
  target: string,
  value: unknown,
): Promise<void> => {
  const expected = canonicalComposedJson(value);
  try {
    const existing = await readFile(target, "utf8");
    if (existing !== expected) throw new TypeError("private composed artifact changed");
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try { await writeFile(target, expected, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST"
      || await readFile(target, "utf8") !== expected) throw error;
  }
};
