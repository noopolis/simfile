import { spawn, type ChildProcess } from "node:child_process";

const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export interface SpawnfileCliContext {
  spawnfileBin: string;
  nodeBin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  terminationGraceMs?: number;
  timeoutMs?: number;
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

type ProcessTreeIdentity = Readonly<{ pgid?: number; pid: number }>;

const processTreeIdentity = (child: ChildProcess, isolatedGroup: boolean): ProcessTreeIdentity => {
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || pid === undefined || pid <= 1 || pid === process.pid) {
    throw new Error("spawnfile CLI child process identity is invalid");
  }
  return isolatedGroup ? { pgid: pid, pid } : { pid };
};

const signalProcessTree = (
  child: ChildProcess,
  identity: ProcessTreeIdentity,
  signal: "SIGKILL" | "SIGTERM",
): void => {
  if (identity.pgid !== undefined) {
    if (!Number.isSafeInteger(identity.pgid) || identity.pgid <= 1
      || identity.pgid === process.pid || identity.pgid !== identity.pid) {
      throw new Error("spawnfile CLI child process group is invalid");
    }
    try { process.kill(-identity.pgid, signal); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    return;
  }
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(identity.pid), "/T",
      ...(signal === "SIGKILL" ? ["/F"] : [])], { stdio: "ignore", windowsHide: true });
    killer.unref();
    return;
  }
  throw new Error("spawnfile CLI child process group is unavailable");
};

const processGroupIsAlive = (identity: ProcessTreeIdentity): boolean => {
  if (identity.pgid === undefined) return true;
  try {
    process.kill(-identity.pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
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
  let timedOut = false;
  let closed = false;
  let closeCode: number | null = null;
  let escalationComplete = false;
  let killTimer: NodeJS.Timeout | undefined;
  const timeoutMs = boundedMilliseconds(context.timeoutMs, 120_000, 600_000, "timeout");
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
    else if (code !== 0) reject(new Error(
      `spawnfile CLI operation failed with exit code ${code ?? "unknown"}`,
    ));
    else resolve({ stdout, stderr });
  };
  const terminate = (reason: "abort" | "timeout"): void => {
    if (settled) return;
    aborted = reason === "abort";
    timedOut = reason === "timeout";
    signalProcessTree(child, identity, "SIGTERM");
    killTimer ??= setTimeout(() => {
      signalProcessTree(child, identity, "SIGKILL");
      escalationComplete = true;
      if (closed) finish(undefined, closeCode);
    }, graceMs);
    killTimer.unref();
  };
  const abort = (): void => terminate("abort");
  const collect = (kind: "stdout" | "stderr") => (chunk: Buffer): void => {
    const next = (kind === "stdout" ? stdout : stderr) + chunk.toString("utf8");
    if (Buffer.byteLength(next, "utf8") > MAX_BUFFER_BYTES) {
      signalProcessTree(child, identity, "SIGKILL");
      finish(new Error("spawnfile CLI output exceeded limit"));
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
    if ((aborted || timedOut) && !escalationComplete && processGroupIsAlive(identity)) return;
    finish(undefined, code);
  });
  child.stdin.once("error", () => undefined);
  child.stdin.end(input.stdin);
});

export const runSpawnfileProcess = (
  context: SpawnfileCliContext,
  input: Readonly<{
    args: readonly string[];
    signal?: AbortSignal;
    stdin?: Uint8Array;
  }>,
): Promise<{ stdout: string; stderr: string }> => runBoundedProcess(context, {
  ...input,
  // Node recognizes options such as --env-file even after a script path.
  // Keep every Spawnfile flag on the child CLI side of the option boundary.
  args: ["--", context.spawnfileBin, ...input.args],
  executable: context.nodeBin ?? process.execPath,
});

/** Recreates private target config in memory from one durable nonsecret argv contract. */
export const runSpawnfileConfigProducer = async (input: Readonly<{
  args: readonly string[];
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  terminationGraceMs?: number;
  timeoutMs?: number;
}>): Promise<Uint8Array> => {
  if (input.command.length < 1 || input.command.length > 4_096 || input.command.includes("\0")
    || input.args.length > 32 || input.args.some((value) =>
      value.length < 1 || value.length > 4_096 || value.includes("\0"))) {
    throw new Error("spawnfile target config producer argv is invalid");
  }
  const { stdout } = await runBoundedProcess({
    cwd: input.cwd,
    env: input.env,
    terminationGraceMs: input.terminationGraceMs,
    timeoutMs: input.timeoutMs,
  }, {
    args: input.args,
    executable: input.command,
    signal: input.signal,
  });
  const bytes = new TextEncoder().encode(stdout);
  if (bytes.byteLength < 1 || bytes.byteLength > 262_144) {
    bytes.fill(0);
    throw new Error("spawnfile target config producer output is invalid");
  }
  return bytes;
};
