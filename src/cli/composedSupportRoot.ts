import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

const assertSupportRoot = (supportRoot: string): void => {
  if (!path.isAbsolute(supportRoot) || path.normalize(supportRoot) !== supportRoot
    || supportRoot === path.parse(supportRoot).root) {
    throw new TypeError("composed support root is invalid");
  }
};

/** Removes only the exact private root whose ownership a bootstrap returned. */
export const removeComposedSupportRoot = async (supportRoot: string): Promise<void> => {
  assertSupportRoot(supportRoot);
  await rm(supportRoot, { force: true, recursive: true });
};

/** Owns a newly-created bootstrap root until its preparation callback succeeds. */
export const withComposedSupportRoot = async <T>(
  supportRoot: string,
  prepare: (supportRoot: string) => Promise<T>,
): Promise<T> => {
  assertSupportRoot(supportRoot);
  await mkdir(path.dirname(supportRoot), { recursive: true, mode: 0o700 });
  await mkdir(supportRoot, { mode: 0o700 });
  try {
    return await prepare(supportRoot);
  } catch (error) {
    try {
      await removeComposedSupportRoot(supportRoot);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "composed bootstrap failed and its private support root could not be removed",
      );
    }
    throw error;
  }
};
