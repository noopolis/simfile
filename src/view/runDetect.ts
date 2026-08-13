import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Detects a run-record directory (`manifest.json` @ `simfile.run-manifest.v1`)
 * so `simfile view <dir>` can pick the run-reader replay mode instead of the
 * world/3D replay mode. Deliberately narrow: it checks the one artifact that
 * names the family, never a full manifest parse — `runObserve` does the real
 * validation once this returns true.
 *
 * This used to ALSO require a moltnet transcript
 * (`raw/moltnet/transcript.json`, or a per-network
 * `raw/moltnet/<network_id>/transcript.json`), which silently assumed every
 * run-manifest.v1 directory came from a compose-and-observe run with transport
 * transcripts. A local `simfile run` has no moltnet and no reason to fabricate
 * one, so detection returned false and `simfile view` fell through to the
 * world/3D replay mode, whose artifacts (`manifest.yaml`, `viewer-trace.json`)
 * that run never produced — the "Replay artifact check failed" bug (B192).
 * The transcript was never what made the directory readable; the manifest is.
 * Do not reintroduce a transport-shaped precondition here.
 */
export const isObserveRunDir = async (dirPath: string): Promise<boolean> => {
  try {
    const raw = JSON.parse(await readFile(path.join(dirPath, "manifest.json"), "utf8")) as { version?: unknown };
    return raw.version === "simfile.run-manifest.v1";
  } catch {
    return false;
  }
};
