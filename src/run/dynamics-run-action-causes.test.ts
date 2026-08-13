import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createDynamicsRunActionCauseIndex } from "./dynamics-run-action-causes.js";

test("uses a fixed-width scratch index for historical accepted action causes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "simfile-action-causes-"));
  try {
    const index = await createDynamicsRunActionCauseIndex(root, "run-one");
    await index.record(1, 7);
    await index.record(4, 11);
    assert.equal(await index.lookup(1), "simfile:run-one:7");
    assert.equal(await index.lookup(2), undefined);
    assert.equal(await index.lookup(4), "simfile:run-one:11");
    await index.close();
    await assert.rejects(access(path.join(root, ".dynamics-action-causes")));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
