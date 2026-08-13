import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import { ensurePublicPackageBuild } from "../publicPackageBuild.test-helper.js";
import * as dynamics from "./index.js";

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
  assert.match(`${error.stdout ?? ""}${error.stderr ?? ""}`, new RegExp(`${diagnosticCode}: .*['\"]${symbol}['\"]`, "u"));
}

describe("dynamics public surface", () => {
  it("exposes the audited fixture boundary without a caller-controlled session constructor", () => {
    assert.equal(typeof dynamics.loadDynamicsSession, "function");
    for (const name of [
      "canonicalDynamicsJson",
      "parseDynamicsActionAttempt",
      "parseDynamicsProvenance",
      "prepareDynamicsBuild",
      "persistDynamicsBuild",
      "createDynamicsBuildReceipt",
      "parseDynamicsSessionSnapshot"
    ]) assert.equal(typeof dynamics[name as keyof typeof dynamics], "function", `${name} must be public`);
    assert.equal("cloneDynamicsJson" in dynamics, false);
    assert.equal("cloneDynamicsJsonObject" in dynamics, false);
    assert.equal("createDynamicsSession" in dynamics, false);
    assert.equal("DynamicsSession" in dynamics, false);
  });

  it("keeps B107 dynamics additions off the built root while preserving its existing contract", async () => {
    const consumerRoot = await mkdtemp(path.join(tmpdir(), "simfile-root-dynamics-consumer-"));
    try {
      await ensurePublicPackageBuild(packageRoot);
      await mkdir(path.join(consumerRoot, "node_modules"), { recursive: true });
      await symlink(packageRoot, path.join(consumerRoot, "node_modules", "simfile"), "dir");
      const acceptedSource = path.join(consumerRoot, "accepted.mts");
      await writeFile(acceptedSource, [
        'import { DYNAMICS_OBSERVATION_VERSION, DYNAMICS_PROVIDER_API_VERSION, DYNAMICS_SNAPSHOT_VERSION, loadDynamicsSession } from "simfile";',
        'if (typeof loadDynamicsSession !== "function") throw new Error("missing root loadDynamicsSession");',
        'if (!DYNAMICS_OBSERVATION_VERSION || !DYNAMICS_PROVIDER_API_VERSION || !DYNAMICS_SNAPSHOT_VERSION) throw new Error("missing root dynamics versions");'
      ].join("\n"));
      await execFileAsync(process.execPath, [tscPath, "--pretty", "false", "--target", "ES2023", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--strict", "--skipLibCheck", "--outDir", path.join(consumerRoot, "out"), acceptedSource], { cwd: consumerRoot });
      await execFileAsync(process.execPath, [path.join(consumerRoot, "out", "accepted.mjs")], { cwd: consumerRoot });

      for (const [symbol, diagnosticCode] of [
        ["canonicalDynamicsJson", "TS2305"],
        ["parseDynamicsActionAttempt", "TS2724"],
        ["parseDynamicsProvenance", "TS2724"],
        ["prepareDynamicsBuild", "TS2305"],
        ["persistDynamicsBuild", "TS2305"],
        ["createDynamicsBuildReceipt", "TS2724"],
        ["parseDynamicsSessionSnapshot", "TS2724"]
      ] as const) {
        const forbiddenSource = path.join(consumerRoot, `forbidden-${symbol}.mts`);
        await writeFile(forbiddenSource, `import { ${symbol} } from "simfile";\nvoid ${symbol};\n`);
        await assertMissingRootExport(
          execFileAsync(process.execPath, [tscPath, "--pretty", "false", "--target", "ES2023", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--strict", "--skipLibCheck", "--noEmit", forbiddenSource], { cwd: consumerRoot }),
          diagnosticCode,
          symbol
        );
      }
      for (const symbol of ["DynamicsBuildArtifactLifecycle", "PreparedDynamicsBuild"]) {
        const forbiddenSource = path.join(consumerRoot, `forbidden-${symbol}.mts`);
        await writeFile(forbiddenSource, `import type { ${symbol} } from "simfile";\ndeclare const value: ${symbol};\nvoid value;\n`);
        await assertMissingRootExport(
          execFileAsync(process.execPath, [tscPath, "--pretty", "false", "--target", "ES2023", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--strict", "--skipLibCheck", "--noEmit", forbiddenSource], { cwd: consumerRoot }),
          "TS2305",
          symbol
        );
      }
    } finally {
      await rm(consumerRoot, { force: true, recursive: true });
    }
  });
});
