import { spawn } from "node:child_process";

import {
  assertBootstrapLocalExecutableIdentity,
  type BootstrapLocalExecutableIdentity,
} from "./executableIdentity.js";
import {
  processGroupIsAlive,
  processTreeIdentity,
  signalProcessTree,
  type ProcessTreeIdentity,
} from "./processTree.js";

export {
  assertBootstrapLocalExecutableIdentity,
  captureBootstrapLocalExecutableIdentity,
  type BootstrapLocalExecutableIdentity,
} from "./executableIdentity.js";

const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
export const COMPOSED_SPAWNFILE_OPERATION_TIMEOUT_MS = 600_000;

export interface SpawnfileCliContext {
  spawnfileBin: string;
  maxBufferBytes?: number;
  nodeBin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  terminationGraceMs?: number;
  timeoutMs?: number;
}

/** Internal bootstrap context; never expose it through the public Spawnfile barrel. */
export interface BootstrapSpawnfileCliContext extends SpawnfileCliContext {
  readonly bootstrapLocalExecutableIdentity: BootstrapLocalExecutableIdentity;
}

const boundedMilliseconds = (
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number => {
  const parsed = value ?? fallback;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`spawnfile CLI ${label} is invalid`);
  }
  return parsed;
};

const runBoundedProcess = (
  context: Omit<SpawnfileCliContext, "spawnfileBin" | "nodeBin">,
  input: Readonly<{
    args: readonly string[];
    executable: string;
    signal?: AbortSignal;
    stdin?: Uint8Array;
  }>,
): Promise<{ stdout: string; stderr: string }> => new Promise((resolve, reject) => {
  if (input.signal?.aborted) {
    reject(new Error("spawnfile CLI operation aborted"));
    return;
  }
  const child = spawn(input.executable, input.args, {
    cwd: context.cwd,
    detached: process.platform !== "win32",
    env: context.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let identity: ProcessTreeIdentity;
  try {
    identity = processTreeIdentity(child, process.platform !== "win32");
  } catch (error) {
    child.kill("SIGKILL");
    reject(error);
    return;
  }
  let stdout = "";
  let stderr = "";
  let settled = false;
  let aborted = false;
  let outputExceeded = false;
  let timedOut = false;
  let closed = false;
  let closeCode: number | null = null;
  let escalationComplete = false;
  let killTimer: NodeJS.Timeout | undefined;
  const timeoutMs = boundedMilliseconds(context.timeoutMs, 120_000, 600_000, "timeout");
  const maxBufferBytes = boundedMilliseconds(
    context.maxBufferBytes, MAX_BUFFER_BYTES, MAX_BUFFER_BYTES, "output limit",
  );
  const graceMs = boundedMilliseconds(
    context.terminationGraceMs, 1_000, 30_000, "termination grace",
  );
  const cleanup = (): void => {
    clearTimeout(timeoutTimer);
    if (killTimer !== undefined) clearTimeout(killTimer);
    input.signal?.removeEventListener("abort", abort);
  };
  const finish = (error?: Error, code?: number | null): void => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) reject(error);
    else if (aborted) reject(new Error("spawnfile CLI operation aborted"));
    else if (timedOut) reject(new Error("spawnfile CLI operation timed out"));
    else if (outputExceeded) reject(new Error("spawnfile CLI output exceeded limit"));
    else if (code !== 0) {
      const failure = new Error(
        `spawnfile CLI operation failed with exit code ${code ?? "unknown"}`,
      );
      Object.defineProperty(failure, "stderr", { enumerable: false, value: stderr });
      reject(failure);
    }
    else resolve({ stdout, stderr });
  };
  const awaitQuiescence = (deadline: number, failure: string): void => {
    const quiesced = identity.pgid === undefined ? closed : !processGroupIsAlive(identity);
    if (quiesced) {
      escalationComplete = true;
      finish(undefined, closeCode);
      return;
    }
    if (Date.now() >= deadline) {
      escalationComplete = true;
      finish(new Error(failure));
      return;
    }
    killTimer = setTimeout(() => awaitQuiescence(deadline, failure), 5);
  };
  const terminate = (reason: "abort" | "timeout"): void => {
    if (settled) return;
    aborted = reason === "abort";
    timedOut = reason === "timeout";
    try { signalProcessTree(child, identity, "SIGTERM"); }
    catch { finish(new Error("spawnfile CLI termination failed")); return; }
    killTimer ??= setTimeout(() => {
      try { signalProcessTree(child, identity, "SIGKILL"); }
      catch { finish(new Error("spawnfile CLI termination failed")); return; }
      awaitQuiescence(Date.now() + graceMs, "spawnfile CLI termination did not quiesce");
    }, graceMs);
  };
  const abort = (): void => terminate("abort");
  const collect = (kind: "stdout" | "stderr") => (chunk: Buffer): void => {
    const next = (kind === "stdout" ? stdout : stderr) + chunk.toString("utf8");
    if (Buffer.byteLength(next, "utf8") > maxBufferBytes) {
      if (outputExceeded) return;
      outputExceeded = true;
      try { signalProcessTree(child, identity, "SIGKILL"); }
      catch { finish(new Error("spawnfile CLI output termination failed")); return; }
      awaitQuiescence(Date.now() + graceMs, "spawnfile CLI output termination did not quiesce");
    } else if (kind === "stdout") stdout = next;
    else stderr = next;
  };
  const timeoutTimer = setTimeout(() => terminate("timeout"), timeoutMs);
  timeoutTimer.unref();
  input.signal?.addEventListener("abort", abort, { once: true });
  child.stdout.on("data", collect("stdout"));
  child.stderr.on("data", collect("stderr"));
  child.once("error", () => finish(new Error("spawnfile CLI operation failed to start")));
  child.once("close", (code) => {
    closed = true;
    closeCode = code;
    if ((aborted || timedOut || outputExceeded)
      && !escalationComplete && processGroupIsAlive(identity)) return;
    finish(undefined, code);
  });
  child.stdin.once("error", () => undefined);
  child.stdin.end(input.stdin);
});

export const runSpawnfileProcess = (
  context: SpawnfileCliContext | BootstrapSpawnfileCliContext,
  input: Readonly<{
    args: readonly string[];
    signal?: AbortSignal;
    stdin?: Uint8Array;
  }>,
): Promise<{ stdout: string; stderr: string }> => (async () => {
  if ("bootstrapLocalExecutableIdentity" in context) {
    if (context.bootstrapLocalExecutableIdentity.path !== context.spawnfileBin) {
      throw new TypeError("bootstrap Spawnfile executable identity does not match its path");
    }
    await assertBootstrapLocalExecutableIdentity(context.bootstrapLocalExecutableIdentity);
  }
  return runBoundedProcess(context, {
  ...input,
  // Node recognizes options such as --env-file even after a script path.
  // Keep every Spawnfile flag on the child CLI side of the option boundary.
  args: ["--", context.spawnfileBin, ...input.args],
  executable: context.nodeBin ?? process.execPath,
  });
})();
