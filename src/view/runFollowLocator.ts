import { access, readdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

import { dynamicsRunStagingPrefix } from "../run/dynamics-run-artifacts.js";

const isCode = (value: unknown, code: string): boolean =>
  typeof value === "object"
  && value !== null
  && (value as { code?: unknown }).code === code;

export const findInProgressDynamicsRun = async (
  outDir: string
): Promise<string | undefined> => {
  try {
    await access(join(outDir, "manifest.json"));
    return undefined;
  } catch (failure) {
    if (!isCode(failure, "ENOENT")) throw failure;
  }

  let entries;
  try {
    entries = await readdir(dirname(outDir), { withFileTypes: true });
  } catch (failure) {
    if (isCode(failure, "ENOENT")) return undefined;
    throw failure;
  }
  const candidates = entries
    .filter((entry) =>
      entry.name.startsWith(dynamicsRunStagingPrefix(outDir))
      && entry.isDirectory()
    )
    .map((entry) => join(dirname(outDir), entry.name));
  if (candidates.length === 0) return undefined;
  if (candidates.length > 1) {
    throw new Error(
      `ambiguous in-progress dynamics run staging directories: ${candidates.join(", ")}`
    );
  }
  return realpath(candidates[0]);
};
