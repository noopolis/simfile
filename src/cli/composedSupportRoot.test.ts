import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { removeComposedSupportRoot, withComposedSupportRoot } from "./composedSupportRoot.js";

test("failed composed preparation removes only its newly-created support root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simfile-support-root-"));
  const sibling = path.join(root, "keep.txt");
  const support = path.join(root, ".simfile-composed", "failed-run");
  try {
    await writeFile(sibling, "keep\n");
    await assert.rejects(withComposedSupportRoot(support, async (created) => {
      await writeFile(path.join(created, "partial.json"), "{}\n");
      throw new Error("injected bootstrap failure");
    }), /injected bootstrap failure/u);
    await assert.rejects(access(support));
    assert.equal(await readFile(sibling, "utf8"), "keep\n");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("successful composed preparation retains its durable support root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simfile-support-root-"));
  const support = path.join(root, ".simfile-composed", "successful-run");
  try {
    const result = await withComposedSupportRoot(support, async (created) => {
      await writeFile(path.join(created, "prepared.json"), "{}\n");
      return "prepared";
    });
    assert.equal(result, "prepared");
    assert.equal(await readFile(path.join(support, "prepared.json"), "utf8"), "{}\n");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("transferred support-root ownership can be released without touching its sibling", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simfile-support-root-release-"));
  const support = path.join(root, ".simfile-composed", "released-run");
  const sibling = path.join(root, "keep.txt");
  try {
    await writeFile(sibling, "keep\n");
    await withComposedSupportRoot(support, async (created) => {
      await writeFile(path.join(created, "owned.json"), "{}\n");
    });
    await removeComposedSupportRoot(support);
    await assert.rejects(access(support));
    assert.equal(await readFile(sibling, "utf8"), "keep\n");
    await assert.rejects(removeComposedSupportRoot(path.parse(support).root), /root is invalid/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
