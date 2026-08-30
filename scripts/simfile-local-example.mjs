#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runBoundedProcess } from "./bounded-process.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const createLocalExampleInvocation = (nonce = randomUUID()) => {
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

export const runLocalExample = async (nonce) => {
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

if (process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runLocalExample(); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
