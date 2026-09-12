#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import path from "node:path";
import { runBoundedProcess } from "./bounded-process.ts";
import { isMainModule } from "./entrypoint.ts";
import { resolvePackageRoot } from "./package-root.ts";

const packageRoot = resolvePackageRoot(import.meta.url);

export interface LocalExampleInvocation {
  args: readonly string[];
  out: string;
  run_id: string;
}

export const createLocalExampleInvocation = (nonce: string = randomUUID()): Readonly<LocalExampleInvocation> => {
  if (!/^[a-f0-9-]{8,64}$/u.test(nonce)) {
    throw new TypeError("Local example nonce is invalid");
  }
  const runId = `example-local-${nonce}`;
  const out = path.join("runs", runId);
  return Object.freeze({
    args: Object.freeze([
      path.join(packageRoot, "dist", "cli", "index.js"),
      "run",
      path.join(packageRoot, "examples", "jungian-dialogue", "Simfile"),
      "--local", "--ticks", "12", "--run-id", runId, "--out", out,
    ]),
    out,
    run_id: runId,
  });
};

export const runLocalExample = async (nonce?: string): Promise<Readonly<LocalExampleInvocation>> => {
  const invocation = createLocalExampleInvocation(nonce);
  const result = await runBoundedProcess(process.execPath, invocation.args, {
    cwd: packageRoot,
    env: process.env,
    timeoutMs: 10 * 60 * 1000,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return invocation;
};

if (isMainModule(import.meta.url)) {
  try { await runLocalExample(); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
