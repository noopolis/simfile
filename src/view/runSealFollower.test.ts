import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";

import { startRunSealFollower } from "./runSealFollower.js";

it("reconciles a seal without an SSE or browser consumer", async () => {
  const runDir = await mkdtemp(path.join(tmpdir(), "simfile-seal-follower-"));
  let calls = 0;
  const follower = startRunSealFollower({
    initialIdentities: [{ id: "fixture-renderer", status: "unsealed/local" }],
    pollMs: 5,
    reconcileAtSeal: async () => {
      calls += 1;
      return [{ id: "fixture-renderer", status: "recorded" }];
    },
    runDir,
  });
  try {
    await writeFile(path.join(runDir, "manifest.json"), "{}\n");
    const terminal = await follower.awaitTerminal();
    assert.equal(terminal.status, "recorded");
    assert.deepEqual(follower.getState(), {
      identities: [{ id: "fixture-renderer", status: "recorded" }],
      status: "recorded",
    });
    assert.equal(calls, 1);
  } finally {
    follower.close();
    await rm(runDir, { force: true, recursive: true });
  }
});

it("retains a visible failed state after a seal mismatch", async () => {
  const runDir = await mkdtemp(path.join(tmpdir(), "simfile-seal-mismatch-"));
  const follower = startRunSealFollower({
    pollMs: 5,
    reconcileAtSeal: async () => {
      throw new Error("digest mismatch");
    },
    runDir,
  });
  try {
    await writeFile(path.join(runDir, "manifest.json"), "{}\n");
    await follower.awaitTerminal();
    assert.equal(follower.getState().status, "failed");
    assert.match(follower.getState().error ?? "", /digest mismatch/u);
  } finally {
    follower.close();
    await rm(runDir, { force: true, recursive: true });
  }
});
