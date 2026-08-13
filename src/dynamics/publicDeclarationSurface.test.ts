import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import ts from "typescript";

import { ensurePublicPackageBuild } from "../publicPackageBuild.test-helper.js";

const packageRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const distRoot = path.join(packageRoot, "dist");
const entryPath = path.join(distRoot, "dynamics", "index.d.ts");

const normalizedRelativePath = (filePath: string): string =>
  path.relative(packageRoot, filePath).split(path.sep).join("/");

const declarationImportPath = (fromPath: string, specifier: string): string => {
  const resolved = path.resolve(path.dirname(fromPath), specifier);
  return /\.[cm]?js$/u.test(resolved)
    ? resolved.replace(/\.([cm]?)js$/u, ".d.$1ts")
    : resolved;
};

it("keeps the public dynamics declaration closure out of the package barrel and world server", async () => {
  await ensurePublicPackageBuild(packageRoot);
  const pending = [{ filePath: entryPath, chain: [normalizedRelativePath(entryPath)] }];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const current = pending.shift();
    assert.ok(current);
    const relativePath = normalizedRelativePath(current.filePath);
    assert.notEqual(
      relativePath,
      "dist/index.d.ts",
      `dynamics declaration surface reached the package barrel: ${current.chain.join(" -> ")}`
    );
    assert.equal(
      relativePath.startsWith("dist/world-server/"),
      false,
      `dynamics declaration surface reached world-server: ${current.chain.join(" -> ")}`
    );
    if (visited.has(current.filePath)) continue;
    visited.add(current.filePath);

    const preprocessed = ts.preProcessFile(await readFile(current.filePath, "utf8"), true, true);
    const specifiers = [...preprocessed.importedFiles, ...preprocessed.referencedFiles]
      .map(({ fileName }) => fileName)
      .filter((specifier) => specifier.startsWith("."));
    for (const specifier of specifiers) {
      const filePath = declarationImportPath(current.filePath, specifier);
      pending.push({
        filePath,
        chain: [...current.chain, normalizedRelativePath(filePath)]
      });
    }
  }

  assert.ok(visited.size > 1, "dynamics declaration closure walk must traverse relative imports");
});
