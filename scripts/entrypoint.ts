import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const asPath = (value: string): string => value.startsWith("file:") ? fileURLToPath(value) : value;

const canonicalPath = (value: string): string => {
  const resolved = path.resolve(asPath(value));
  try { return realpathSync.native(resolved); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolved;
    throw error;
  }
};

export const isMainModule = (moduleUrl: string, argv: readonly string[] = process.argv): boolean => {
  const entrypoint = argv[1];
  if (entrypoint === undefined) return false;
  return canonicalPath(fileURLToPath(moduleUrl)) === canonicalPath(entrypoint);
};
