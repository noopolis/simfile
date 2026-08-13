import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import ts from "typescript";

import { ensurePublicPackageBuild } from "../publicPackageBuild.test-helper.js";

const packageRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const tscPath = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc");
const execFileAsync = promisify(execFile);
const expectedRuntimeTypeExports = [
  "RuntimeTraceEvent",
  "ViewerContractTrace",
  "ViewerTraceFact",
  "ViewerTraceInspection",
  "ViewerTraceInspectionSample",
] as const;

test("runtime subpath exports exactly its consumed artifact types while the root retains causal conversion", async () => {
  const barrel = await readFile(path.join(packageRoot, "src", "runtime", "index.ts"), "utf8");
  const source = ts.createSourceFile("src/runtime/index.ts", barrel, ts.ScriptTarget.Latest, true);
  const exportedNames: string[] = [];
  for (const statement of source.statements) {
    assert.ok(ts.isExportDeclaration(statement), "the runtime barrel may contain only export declarations");
    assert.equal(statement.isTypeOnly, true, "every runtime subpath export must use export type");
    assert.ok(statement.exportClause && ts.isNamedExports(statement.exportClause),
      "the runtime barrel must use explicit named exports");
    for (const element of statement.exportClause.elements) {
      exportedNames.push((element.propertyName ?? element.name).text);
    }
  }
  assert.equal(exportedNames.length, new Set(exportedNames).size,
    "the runtime barrel must not duplicate an exported name");
  assert.deepEqual(new Set(exportedNames), new Set(expectedRuntimeTypeExports));

  const consumerRoot = await mkdtemp(path.join(tmpdir(), "simfile-runtime-consumer-"));
  try {
    await ensurePublicPackageBuild(packageRoot);
    await mkdir(path.join(consumerRoot, "node_modules"), { recursive: true });
    await symlink(packageRoot, path.join(consumerRoot, "node_modules", "simfile"), "dir");
    const sourcePath = path.join(consumerRoot, "consumer.mts");
    await writeFile(sourcePath, [
      'import { toCausalFixtureRecord } from "simfile";',
      'import type { RuntimeTraceEvent } from "simfile/runtime";',
      'const event = { kind: "world.message", event_id: "event-1", payload: { text: "hello" } } as unknown as RuntimeTraceEvent;',
      'const record = toCausalFixtureRecord(event);',
      'if (record.event_id !== "event-1") throw new Error("root causal conversion is unavailable");'
    ].join("\n"));
    const outputDirectory = path.join(consumerRoot, "out");
    await execFileAsync(process.execPath, [
      tscPath,
      "--pretty", "false",
      "--target", "ES2023",
      "--module", "NodeNext",
      "--moduleResolution", "NodeNext",
      "--strict",
      "--skipLibCheck",
      "--rootDir", consumerRoot,
      "--outDir", outputDirectory,
      sourcePath
    ], { cwd: consumerRoot });
    const emittedPath = path.join(outputDirectory, "consumer.mjs");
    const emitted = await readFile(emittedPath, "utf8");
    assert.match(emitted, /from ["']simfile["']/u);
    assert.doesNotMatch(emitted, /simfile\/runtime/u);
    await execFileAsync(process.execPath, [emittedPath], { cwd: consumerRoot });

    const removedNameSource = path.join(consumerRoot, "removed-name-consumer.mts");
    await writeFile(removedNameSource, [
      'import type { ViewerInspectionField } from "simfile/runtime";',
      "declare const field: ViewerInspectionField;",
      "void field;"
    ].join("\n"));
    await assert.rejects(
      execFileAsync(process.execPath, [
        tscPath,
        "--pretty", "false",
        "--target", "ES2023",
        "--module", "NodeNext",
        "--moduleResolution", "NodeNext",
        "--strict",
        "--skipLibCheck",
        "--noEmit",
        removedNameSource
      ], { cwd: consumerRoot }),
      (error: unknown) => {
        assert.ok(error instanceof Error && "code" in error
          && typeof error.code === "number" && error.code !== 0,
        "the TypeScript compiler must exit with a non-zero status");
        assert.ok("stdout" in error && typeof error.stdout === "string",
          "the failed TypeScript process must expose compiler diagnostics on stdout");
        assert.match(error.stdout,
          /error TS2305: Module '"simfile\/runtime"' has no exported member 'ViewerInspectionField'\./u);
        return true;
      },
      "a removed runtime type must be rejected by TypeScript"
    );
  } finally {
    await rm(consumerRoot, { force: true, recursive: true });
  }
});
