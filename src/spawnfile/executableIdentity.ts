import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

export interface BootstrapLocalExecutableIdentity {
  readonly path: string;
  readonly sha256: `sha256:${string}`;
}

const executableDigest = async (file: string): Promise<`sha256:${string}`> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk: string | Buffer) => { hash.update(chunk); });
    stream.once("error", reject);
    stream.once("end", () => resolve(`sha256:${hash.digest("hex")}`));
  });

export const captureBootstrapLocalExecutableIdentity = async (
  executablePath: string,
): Promise<BootstrapLocalExecutableIdentity> => {
  if (!(await stat(executablePath)).isFile()) {
    throw new TypeError("bootstrap executable must be a regular file");
  }
  return Object.freeze({ path: executablePath, sha256: await executableDigest(executablePath) });
};

export const assertBootstrapLocalExecutableIdentity = async (
  identity: BootstrapLocalExecutableIdentity,
): Promise<void> => {
  let current: BootstrapLocalExecutableIdentity;
  try { current = await captureBootstrapLocalExecutableIdentity(identity.path); }
  catch { throw new TypeError("bootstrap executable is unavailable or changed"); }
  if (current.sha256 !== identity.sha256) {
    throw new TypeError("bootstrap executable changed during composed bootstrap");
  }
};
