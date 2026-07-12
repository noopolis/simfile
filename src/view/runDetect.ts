import { access, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Detects a compose-and-observe run directory (`simfile.run-manifest.v1` +
 * `raw/moltnet/transcript.json`) so `simfile view <dir>` can pick the
 * run-reader replay mode instead of the world/3D replay mode. Deliberately
 * narrow: it only checks the two artifacts that make the golden fixture
 * (`fixtures/observe/office-sim-golden/`) and any future real run directory
 * (e.g. `runs/real-grok-office/`) renderable, never a full manifest parse —
 * `runObserve` does the real validation once this returns true.
 */
export const isObserveRunDir = async (dirPath: string): Promise<boolean> => {
  const transcriptPath = path.join(dirPath, "raw", "moltnet", "transcript.json");
  const manifestPath = path.join(dirPath, "manifest.json");

  try {
    await access(transcriptPath);
  } catch {
    return false;
  }

  try {
    const raw = JSON.parse(await readFile(manifestPath, "utf8")) as { version?: unknown };
    return raw.version === "simfile.run-manifest.v1";
  } catch {
    return false;
  }
};
