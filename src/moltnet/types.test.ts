import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { ensurePublicPackageBuild } from "../publicPackageBuild.test-helper.js";
const packageRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const tscPath = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc");
const execFileAsync = promisify(execFile);

async function assertMissingRootExport(compile: Promise<unknown>, diagnosticCode: "TS2305" | "TS2724", symbol: string): Promise<void> {
  let error: { stdout?: string; stderr?: string } | undefined;
  try {
    await compile;
  } catch (caught) {
    error = caught as { stdout?: string; stderr?: string };
  }
  assert.ok(error, `expected simfile root import for ${symbol} to fail TypeScript compilation`);
  const diagnostics = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  assert.match(diagnostics, new RegExp(`${diagnosticCode}: .*['\"]${symbol}['\"]`, "u"));
}

test("MoltnetRoomMessage is an erased simfile/moltnet type and is not root-exported", async () => {
  const consumerRoot = await mkdtemp(path.join(tmpdir(), "simfile-moltnet-type-consumer-"));
  try {
    await ensurePublicPackageBuild(packageRoot);
    await mkdir(path.join(consumerRoot, "node_modules"), { recursive: true });
    await symlink(packageRoot, path.join(consumerRoot, "node_modules", "simfile"), "dir");
    const sourcePath = path.join(consumerRoot, "consumer.mts");
    await writeFile(sourcePath, [
      'import type { MoltnetRoomMessage } from "simfile/moltnet";',
      'const message: MoltnetRoomMessage = { id: "message", from: { id: "agent" }, parts: [] };',
      'if (message.from.id !== "agent") throw new Error("wrong message shape");'
    ].join("\n"));
    const outputDirectory = path.join(consumerRoot, "out");
    await execFileAsync(process.execPath, [tscPath, "--pretty", "false", "--target", "ES2023", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--strict", "--skipLibCheck", "--rootDir", consumerRoot, "--outDir", outputDirectory, sourcePath], { cwd: consumerRoot });
    const emitted = await readFile(path.join(outputDirectory, "consumer.mjs"), "utf8");
    assert.doesNotMatch(emitted, /simfile/u);
    const forbiddenTypeSource = path.join(consumerRoot, "forbidden-root-type.mts");
    await writeFile(forbiddenTypeSource, 'import type { MoltnetRoomMessage } from "simfile";\nconst message: MoltnetRoomMessage = { id: "message", from: { id: "agent" }, parts: [] };\nvoid message;\n');
    await assertMissingRootExport(
      execFileAsync(process.execPath, [tscPath, "--pretty", "false", "--target", "ES2023", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--strict", "--skipLibCheck", "--noEmit", forbiddenTypeSource], { cwd: consumerRoot }),
      "TS2305",
      "MoltnetRoomMessage"
    );
    for (const [specifier, diagnosticCode] of [["simfile", "TS2305"], ["simfile/moltnet", "TS2724"]] as const) {
      const forbiddenValueSource = path.join(consumerRoot, `forbidden-polling-value-${specifier.replace("/", "-")}.mts`);
      await writeFile(forbiddenValueSource, `import { listMoltnetRoomMessages } from "${specifier}";\nvoid listMoltnetRoomMessages;\n`);
      await assertMissingRootExport(
        execFileAsync(process.execPath, [tscPath, "--pretty", "false", "--target", "ES2023", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--strict", "--skipLibCheck", "--noEmit", forbiddenValueSource], { cwd: consumerRoot }),
        diagnosticCode,
        "listMoltnetRoomMessages"
      );
    }
    for (const specifier of ["simfile", "simfile/moltnet"]) {
      const forbiddenPollingTypeSource = path.join(consumerRoot, `forbidden-polling-type-${specifier.replace("/", "-")}.mts`);
      await writeFile(forbiddenPollingTypeSource, `import type { MoltnetRoomClientOptions } from "${specifier}";\nconst options: MoltnetRoomClientOptions = {};\nvoid options;\n`);
      await assertMissingRootExport(
        execFileAsync(process.execPath, [tscPath, "--pretty", "false", "--target", "ES2023", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--strict", "--skipLibCheck", "--noEmit", forbiddenPollingTypeSource], { cwd: consumerRoot }),
        "TS2305",
        "MoltnetRoomClientOptions"
      );
    }
    const root = await import(path.join(packageRoot, "dist", "index.js"));
    const moltnet = await import(path.join(packageRoot, "dist", "moltnet", "index.js"));
    assert.equal("MoltnetRoomMessage" in root, false);
    assert.equal("MoltnetRoomMessage" in moltnet, false);
  } finally {
    await rm(consumerRoot, { force: true, recursive: true });
  }
});
