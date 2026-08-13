import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DYNAMICS_RUN_FRAMES_HEADER_VERSION,
  DYNAMICS_RUN_FRAME_VERSION,
  readRunFrames,
} from "./runFrames.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = path.resolve(here, "..", "..", "fixtures", "observe", "office-sim-golden");
const header = (): string => JSON.stringify({
  bounds: { max: [10, 6], min: [-10, -6] },
  sim_seconds_per_tick: 0.05,
  version: DYNAMICS_RUN_FRAMES_HEADER_VERSION,
});
const frame = (tick: number, x: number): string => JSON.stringify({
  objects: [{ id: "object:a", position: [x, 0], velocity: [1, 0] }],
  tick,
  version: DYNAMICS_RUN_FRAME_VERSION,
});

it("ignores unlisted frames and rejects drift or truncation in a sealed run", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "simfile-run-frames-sealed-"));
  const sealed = path.join(root, "run");
  try {
    await cp(GOLDEN_DIR, sealed, { recursive: true });
    const framesPath = path.join(sealed, "raw", "frames.jsonl");
    await mkdir(path.dirname(framesPath), { recursive: true });
    const bytes = Buffer.from(`${header()}\n${frame(0, 0)}\n`);
    await writeFile(framesPath, bytes);
    assert.equal(await readRunFrames(sealed), undefined);

    const manifestPath = path.join(sealed, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      artifacts: Array<{ path: string; sha256: string }>;
    };
    manifest.artifacts.push({ path: "raw/frames.jsonl",
      sha256: createHash("sha256").update(bytes).digest("hex") });
    await writeFile(manifestPath, JSON.stringify(manifest));
    assert.deepEqual((await readRunFrames(sealed))?.samples.map(({ tick }) => tick), [0]);

    await writeFile(framesPath, `${header()}\n${frame(1, 1)}\n`);
    await assert.rejects(readRunFrames(sealed), /integrity failed/u);

    const incomplete = Buffer.from(`${header()}\n${frame(0, 0)}\n{"version":`);
    await writeFile(framesPath, incomplete);
    manifest.artifacts.at(-1)!.sha256 = createHash("sha256")
      .update(incomplete).digest("hex");
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(readRunFrames(sealed), /not a complete frame track/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
