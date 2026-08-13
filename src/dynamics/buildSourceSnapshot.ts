import { readFileSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import path from "node:path";

import { compareUtf16 } from "./buildIdentity.js";

export interface DynamicsBuildSourceSnapshot {
  readonly readBytes: (fileName: string) => Promise<Uint8Array>;
  readonly readRetainedBytes: (fileName: string) => Promise<Uint8Array>;
  readonly readText: (fileName: string) => Promise<string>;
  readonly readTextSync: (fileName: string) => string | undefined;
  readonly verifyAll: () => Promise<void>;
}

const changed = (fileName: string): Error =>
  new Error(`dynamics build source changed during preparation: ${fileName}`);

/** Retains the first bytes observed and rejects every later cross-phase change. */
export const createDynamicsBuildSourceSnapshot = (): DynamicsBuildSourceSnapshot => {
  const retained = new Map<string, Buffer>();
  const observe = (fileName: string, bytes: Uint8Array): Buffer => {
    const candidate = path.resolve(fileName);
    const existing = retained.get(candidate);
    if (existing) {
      if (!existing.equals(bytes)) throw changed(candidate);
      return existing;
    }
    const snapshot = Buffer.from(bytes);
    retained.set(candidate, snapshot);
    return snapshot;
  };
  const readBytes = async (fileName: string): Promise<Uint8Array> =>
    Buffer.from(observe(fileName, await readFileAsync(fileName)));
  const readTextSync = (fileName: string): string | undefined => {
    try {
      return observe(fileName, readFileSync(fileName)).toString("utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (retained.has(path.resolve(fileName))) throw changed(path.resolve(fileName));
      return undefined;
    }
  };
  return {
    readBytes,
    readRetainedBytes: async (fileName) => {
      const candidate = path.resolve(fileName);
      const bytes = retained.get(candidate);
      if (!bytes) throw new Error(`dynamics build source lacks retained bytes: ${candidate}`);
      return Buffer.from(bytes);
    },
    readText: async (fileName) =>
      new TextDecoder().decode(await readBytes(fileName)),
    readTextSync,
    verifyAll: async () => {
      for (const fileName of [...retained.keys()].sort(compareUtf16)) {
        try {
          observe(fileName, await readFileAsync(fileName));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          throw changed(fileName);
        }
      }
    }
  };
};
