import { spawn, type ChildProcess } from "node:child_process";

export type ProcessTreeIdentity = Readonly<{ pgid?: number; pid: number }>;

export const processTreeIdentity = (
  child: ChildProcess,
  isolatedGroup: boolean,
): ProcessTreeIdentity => {
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || pid === undefined || pid <= 1 || pid === process.pid) {
    throw new Error("spawnfile CLI child process identity is invalid");
  }
  return isolatedGroup ? { pgid: pid, pid } : { pid };
};

export const signalProcessTree = (
  child: ChildProcess,
  identity: ProcessTreeIdentity,
  signal: "SIGKILL" | "SIGTERM",
): void => {
  if (identity.pgid !== undefined) {
    if (!Number.isSafeInteger(identity.pgid) || identity.pgid <= 1
      || identity.pgid === process.pid || identity.pgid !== identity.pid) {
      throw new Error("spawnfile CLI child process group is invalid");
    }
    try { process.kill(-identity.pgid, signal); }
    catch (error) {
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

export const processGroupIsAlive = (identity: ProcessTreeIdentity): boolean => {
  if (identity.pgid === undefined) return true;
  try { process.kill(-identity.pgid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
};
