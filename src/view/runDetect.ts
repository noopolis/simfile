import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Detects a compose-and-observe run directory (`simfile.run-manifest.v1` + at
 * least one moltnet transcript) so `simfile view <dir>` can pick the
 * run-reader replay mode instead of the world/3D replay mode. Deliberately
 * narrow: it only checks the two artifacts that make the golden fixtures
 * (`fixtures/observe/office-sim-golden/`, `fixtures/observe/jungian-daimon-org-golden/`)
 * and any future real run directory renderable, never a full manifest parse —
 * `runObserve` does the real validation once this returns true. A transcript
 * may be the single-network flat `raw/moltnet/transcript.json` OR any
 * multi-network per-network `raw/moltnet/<network_id>/transcript.json`.
 */
const hasMoltnetTranscript = async (dirPath: string): Promise<boolean> => {
  const moltnetDir = path.join(dirPath, "raw", "moltnet");
  try {
    await access(path.join(moltnetDir, "transcript.json"));
    return true;
  } catch {
    // fall through to the per-network scan
  }
  const entries = await readdir(moltnetDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await access(path.join(moltnetDir, entry.name, "transcript.json"));
      return true;
    } catch {
      // keep scanning
    }
  }
  return false;
};

export const isObserveRunDir = async (dirPath: string): Promise<boolean> => {
  if (!(await hasMoltnetTranscript(dirPath))) return false;

  try {
    const raw = JSON.parse(await readFile(path.join(dirPath, "manifest.json"), "utf8")) as { version?: unknown };
    return raw.version === "simfile.run-manifest.v1";
  } catch {
    return false;
  }
};
