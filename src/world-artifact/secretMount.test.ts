import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SIMFILE_SCOPED_SECRET_IDENTIFIER_GRAMMAR,
  SIMFILE_SCOPED_SECRET_MOUNT_LAYOUT,
  scopedSecretMountPath,
} from "./secretMount.js";

test("uses Simfile's scoped-secret mount grammar without deployment imports", async () => {
  assert.equal(SIMFILE_SCOPED_SECRET_IDENTIFIER_GRAMMAR, "^[a-z][a-z0-9_-]{0,63}$");
  assert.equal(SIMFILE_SCOPED_SECRET_MOUNT_LAYOUT, "<scope>/<name>");
  assert.equal(scopedSecretMountPath("runtime", "alpha_token"), "runtime/alpha_token");
  for (const file of ["secretMount.ts", "runnableBundle.ts", "entrypoint.ts", "sidecarFilesystem.ts"]) {
    const source = await readFile(new URL(`./${file}`, import.meta.url), "utf8");
    assert.equal(/\b(?:from|import)\s*["'][^"']*(?:spawnfile|docker)/iu.test(source), false, file);
  }
});

test("scoped-secret mount paths reject traversal, dots, roots, and non-public identifiers", () => {
  for (const [scope, name] of [
    ["../world", "token"], [".", "token"], ["..", "token"], ["/world", "token"],
    ["world", "../token"], ["world", "."], ["world", "/token"], ["world", "token.bearer"],
    ["World", "token"], ["world", "TOKEN"], ["world/token", "name"],
  ]) assert.equal(scopedSecretMountPath(scope, name), undefined);
});
