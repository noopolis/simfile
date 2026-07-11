import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { RunManifestArtifactEntry } from "./manifest.js";

export interface ArtifactIntegrityCheck {
  path: string;
  expectedSha256: string;
  actualSha256: string | null;
  ok: boolean;
}

const sha256Hex = (buffer: Buffer): string => createHash("sha256").update(buffer).digest("hex");

/**
 * Verifies every manifest-declared artifact's sha256 against the file on
 * disk. A mismatch (or a missing file) is reported as a failed check, never
 * silently repaired or stitched over — the caller decides what to do with a
 * failed integrity check (contracts.md: "missing links are reported, not
 * synthesized" applies just as much to artifact bytes as to causal edges).
 */
export const verifyManifestArtifacts = async (
  runDir: string,
  artifacts: readonly RunManifestArtifactEntry[]
): Promise<ArtifactIntegrityCheck[]> => {
  const checks: ArtifactIntegrityCheck[] = [];
  for (const artifact of artifacts) {
    const absolutePath = path.resolve(runDir, artifact.path);
    try {
      const buffer = await readFile(absolutePath);
      const actualSha256 = sha256Hex(buffer);
      checks.push({
        actualSha256,
        expectedSha256: artifact.sha256,
        ok: actualSha256 === artifact.sha256,
        path: artifact.path
      });
    } catch {
      checks.push({ actualSha256: null, expectedSha256: artifact.sha256, ok: false, path: artifact.path });
    }
  }
  return checks;
};
