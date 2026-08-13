import { randomInt } from "node:crypto";
import { mkdir, rmdir } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

export interface LockedTestPort {
  readonly port: number;
  release(): Promise<void>;
}

const lockRoot = path.join(os.tmpdir(), "simfile-world-sidecar-port-locks-v1");
const firstPort = 10_000;
const portCount = 10_000;

const bindCheck = async (port: number): Promise<void> => {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "0.0.0.0", resolve);
    });
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
    }
  }
};

/** Cross-process test authority for a non-ephemeral TCP port. */
export const acquireLockedTestPort = async (): Promise<LockedTestPort> => {
  await mkdir(lockRoot, { recursive: true });
  const offset = randomInt(portCount);
  for (let index = 0; index < portCount; index += 1) {
    const port = firstPort + (offset + index) % portCount;
    const lock = path.join(lockRoot, String(port));
    try {
      await mkdir(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    try {
      await bindCheck(port);
    } catch (error) {
      await rmdir(lock);
      const code = (error as NodeJS.ErrnoException).code ?? "unknown";
      throw new Error(`locked test port ${port} failed bind check (${code})`);
    }
    let released = false;
    return Object.freeze({
      port,
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        await rmdir(lock);
      },
    });
  }
  throw new Error("no cross-process world-sidecar test port lock is available");
};
