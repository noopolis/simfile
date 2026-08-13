import assert from "node:assert/strict";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createDynamicsBuildSourceSnapshot } from "./buildSourceSnapshot.js";

describe("dynamics build source snapshot", () => {
  it("retains first-observed bytes and rejects cross-phase mutation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "simfile-build-snapshot-"));
    const fileName = path.join(directory, "provider.ts");
    try {
      const snapshot = createDynamicsBuildSourceSnapshot();
      await writeFile(fileName, "export const value = 1;\n");
      assert.equal(await snapshot.readText(fileName), "export const value = 1;\n");
      const exposed = await snapshot.readRetainedBytes(fileName);
      assert.equal(
        Buffer.from(exposed).toString("utf8"),
        "export const value = 1;\n"
      );
      exposed[0] = 0;
      assert.equal(
        Buffer.from(await snapshot.readRetainedBytes(fileName)).toString("utf8"),
        "export const value = 1;\n"
      );

      await writeFile(fileName, "export const value = 2;\n");
      await assert.rejects(snapshot.readBytes(fileName), /changed during preparation/u);
      await assert.rejects(snapshot.verifyAll(), /changed during preparation/u);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("distinguishes an absent candidate from removal of retained evidence", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "simfile-build-snapshot-"));
    const fileName = path.join(directory, "types.d.ts");
    try {
      const snapshot = createDynamicsBuildSourceSnapshot();
      assert.equal(snapshot.readTextSync(fileName), undefined);
      await writeFile(fileName, "export type Value = number;\n");
      assert.match(snapshot.readTextSync(fileName) ?? "", /Value/u);
      await unlink(fileName);
      assert.throws(
        () => snapshot.readTextSync(fileName),
        /changed during preparation/u
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
