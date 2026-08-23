import { spawn } from "node:child_process";
import path from "node:path";

const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024 * 1024;
const TERMINATION_GRACE_MS = 1_000;
const QUIESCENCE_TIMEOUT_MS = 1_000;
const QUIESCENCE_POLL_MS = 25;

const signalProcessGroup = (child, signal) => {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, signal);
      return true;
    }
    child.kill(signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
};

const processTreeIsAlive = (child) => {
  if (process.platform === "win32") return child.exitCode === null && child.signalCode === null;
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1 || child.pid === process.pid) {
    throw new Error("Development subprocess group identity is invalid");
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
};

/**
 * Runs a bounded subprocess. On a timeout or bounded-output failure, the
 * entire detached POSIX process group is reaped before the promise settles.
 */
export const runBoundedProcess = (command, args, options = {}) => new Promise((resolve, reject) => {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60 * 1000) {
    reject(new TypeError("Development subprocess timeout is invalid"));
    return;
  }
  const maxOutputBytes = options.maxOutputBytes ?? MAX_PROCESS_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maxOutputBytes)
    || maxOutputBytes < 1 || maxOutputBytes > MAX_PROCESS_OUTPUT_BYTES) {
    reject(new TypeError("Development subprocess output limit is invalid"));
    return;
  }
  const child = spawn(command, args, {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let settled = false;
  let termination;
  let timeoutTimer;
  let forceTimer;
  let quiescenceTimer;
  let forceSent = false;
  let quiescenceDeadline = 0;

  const clearTimers = () => {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    if (forceTimer !== undefined) clearTimeout(forceTimer);
    if (quiescenceTimer !== undefined) clearTimeout(quiescenceTimer);
  };
  const settle = (outcome) => {
    if (settled) return;
    settled = true;
    clearTimers();
    outcome();
  };
  const terminationError = () => termination.reason === "timeout"
    ? new Error(`${path.basename(command)} exceeded its ${timeoutMs}ms timeout`)
    : new Error(`${path.basename(command)} exceeded the bounded output limit`);
  const awaitQuiescence = () => {
    quiescenceTimer = undefined;
    let alive;
    try { alive = processTreeIsAlive(child); }
    catch (error) { settle(() => reject(error)); return; }
    if (!alive) {
      settle(() => reject(terminationError()));
      return;
    }
    if (forceSent && Date.now() >= quiescenceDeadline) {
      settle(() => reject(new Error(
        `${path.basename(command)} process group did not quiesce after SIGKILL`,
      )));
      return;
    }
    quiescenceTimer = setTimeout(awaitQuiescence, QUIESCENCE_POLL_MS);
  };
  const terminate = (reason) => {
    if (termination !== undefined) return;
    termination = { reason };
    try {
      signalProcessGroup(child, "SIGTERM");
      forceTimer = setTimeout(() => {
        try {
          forceSent = true;
          quiescenceDeadline = Date.now() + QUIESCENCE_TIMEOUT_MS;
          signalProcessGroup(child, "SIGKILL");
        } catch (error) {
          settle(() => reject(error));
        }
      }, TERMINATION_GRACE_MS);
      awaitQuiescence();
    } catch (error) {
      settle(() => reject(error));
    }
  };
  const retain = (current, chunk) => {
    if (Buffer.byteLength(current, "utf8") + Buffer.byteLength(chunk, "utf8")
      > maxOutputBytes) {
      terminate("output");
      return current;
    }
    return current + chunk;
  };

  timeoutTimer = setTimeout(() => terminate("timeout"), timeoutMs);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = retain(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = retain(stderr, chunk); });
  child.once("error", (error) => settle(() => reject(error)));
  child.once("close", (code) => {
    if (termination !== undefined) {
      if (quiescenceTimer === undefined) awaitQuiescence();
      return;
    }
    if (code !== 0 && options.allowNonzero !== true) {
      settle(() => reject(new Error(
        `${path.basename(command)} ${args.join(" ")} failed (${code})${stderr ? `\n${stderr.trim()}` : ""}`,
      )));
      return;
    }
    settle(() => resolve({ code: code ?? 1, stderr, stdout }));
  });
});
