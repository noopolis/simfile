import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const LOCK_WAIT_MS = 120_000;
const LOCK_RETRY_MS = 50;
const EMPTY_LOCK_RECOVERY_MS = 5_000;
const BUILD_MARKER = ".simfile-public-package-build-success.json";
const BUILD_MARKER_VERSION = "simfile.public-package-build.v2";
const BUILD_INPUTS = ["package.json", "tsconfig.json", "tsconfig.build.json", "tsconfig.web.json", "src", "web"];
const BUILD_OUTPUT_DIRECTORIES = ["dist", "web/dist"] as const;

type LockOwner = { token: string; pid: number; childPid?: number; processGroupId?: number };
type PublicPackageBuildLock = {
  release: () => Promise<void>;
  trackBuild: (childPid: number) => Promise<void>;
};
export type PublicPackageBuildTestHooks = {
  /** Test-only interruption point: the gated POSIX child exists but cannot build yet. */
  afterGatedChildSpawned?: () => Promise<void> | void;
  /** Test-only interruption point: the build PID/group is durable, but its gate is still closed. */
  afterOwnerRecordedBeforeGate?: () => Promise<void> | void;
  /** Test-only interruption point: the gate is open and the durable child can exec npm. */
  afterGateOpened?: () => Promise<void> | void;
};
type BuildMarker = {
  version: typeof BUILD_MARKER_VERSION;
  inputDigest: string;
  outputs: readonly BuildOutput[];
};
type BuildOutput = { path: string; sha256: string };

const pause = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

const digestPath = async (root: string, relative: string, hash: ReturnType<typeof createHash>): Promise<void> => {
  // Vite emits to web/dist. Hash the full source tree so index.html, public
  // assets, and newly introduced inputs invalidate the marker, but never hash
  // the output tree the marker is meant to validate.
  if (relative === "web/dist" || relative.startsWith("web/dist/")) return;
  const candidate = path.join(root, relative);
  const details = await stat(candidate);
  if (details.isDirectory()) {
    hash.update(`directory:${relative}\0`);
    const entries = await readdir(candidate, { withFileTypes: true });
    for (const { name } of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      await digestPath(root, path.join(relative, name), hash);
    }
    return;
  }
  hash.update(`file:${relative}\0`);
  hash.update(await readFile(candidate));
};

const buildInputDigest = async (packageRoot: string): Promise<string> => {
  const hash = createHash("sha256");
  for (const input of BUILD_INPUTS) await digestPath(packageRoot, input, hash);
  return hash.digest("hex");
};

const normalized = (relative: string): string => relative.split(path.sep).join("/");

const buildOutputManifest = async (packageRoot: string): Promise<BuildOutput[]> => {
  const outputs: BuildOutput[] = [];
  const collect = async (relative: string): Promise<void> => {
    const entries = await readdir(path.join(packageRoot, relative), { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        await collect(child);
        continue;
      }
      if (!entry.isFile()) throw new Error(`public package build output contains unsupported entry ${normalized(child)}`);
      if (normalized(child) === `dist/${BUILD_MARKER}`) continue;
      outputs.push({
        path: normalized(child),
        sha256: createHash("sha256").update(await readFile(path.join(packageRoot, child))).digest("hex")
      });
    }
  };
  for (const directory of BUILD_OUTPUT_DIRECTORIES) await collect(directory);
  if (outputs.length === 0) throw new Error("public package build produced no output files");
  return outputs;
};

const hasSuccessfulBuild = async (packageRoot: string): Promise<boolean> => {
  let marker: BuildMarker;
  try {
    marker = JSON.parse(await readFile(path.join(packageRoot, "dist", BUILD_MARKER), "utf8")) as BuildMarker;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
  if (marker.version !== BUILD_MARKER_VERSION
    || marker.inputDigest !== await buildInputDigest(packageRoot)) return false;
  try {
    return JSON.stringify(marker.outputs) === JSON.stringify(await buildOutputManifest(packageRoot));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const writeBuildMarker = async (packageRoot: string, inputDigest: string): Promise<void> => {
  const outputs = await buildOutputManifest(packageRoot);
  const markerPath = path.join(packageRoot, "dist", BUILD_MARKER);
  const temporaryPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({ version: BUILD_MARKER_VERSION, inputDigest, outputs })}\n`);
  await rename(temporaryPath, markerPath);
};

const writeLockOwner = async (lockPath: string, owner: LockOwner): Promise<void> => {
  const destination = path.join(lockPath, "owner.json");
  const temporary = `${destination}.${owner.token}.tmp`;
  await writeFile(temporary, `${JSON.stringify(owner)}\n`);
  await rename(temporary, destination);
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const emptyLockIsRecoverable = async (lockPath: string): Promise<boolean> => {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs >= EMPTY_LOCK_RECOVERY_MS;
  } catch (error) {
    // The owner released between mkdir's EEXIST result and our inspection.
    // Let the acquisition loop retry mkdir instead of turning that normal race
    // into a test/build failure.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const lockOwnerIsGone = async (lockPath: string): Promise<boolean> => {
  // Windows has no equivalent to the POSIX detached process-group proof below.
  // A failed owner can leave npm descendants that are not safely attributable, so
  // never reclaim a Windows lock automatically: waiters fail closed instead.
  if (process.platform === "win32") return false;
  let owner: Partial<LockOwner>;
  try {
    owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")) as Partial<LockOwner>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    return emptyLockIsRecoverable(lockPath);
  }
  if (typeof owner.token !== "string" || typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0) {
    return emptyLockIsRecoverable(lockPath);
  }
  if (processIsAlive(owner.pid)) return false;
  if (typeof owner.childPid === "number" && Number.isInteger(owner.childPid) && owner.childPid > 0 && processIsAlive(owner.childPid)) return false;
  if (typeof owner.processGroupId === "number" && Number.isInteger(owner.processGroupId) && owner.processGroupId > 0 && processIsAlive(-owner.processGroupId)) return false;
  return true;
};

const reclaimStaleLock = async (lockPath: string): Promise<void> => {
  // Never recursively remove the shared pathname after observing stale state:
  // another waiter could have already replaced it with a live lock.  Rename is
  // atomic, so a loser only sees ENOENT and cannot delete that new owner.
  const reclaimedPath = `${lockPath}.reclaim-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockPath, reclaimedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await rm(reclaimedPath, { force: true, recursive: true });
};

const acquireBuildLock = async (packageRoot: string): Promise<PublicPackageBuildLock> => {
  const key = createHash("sha256").update(path.resolve(packageRoot)).digest("hex");
  const lockPath = path.join(tmpdir(), `simfile-public-package-build-${key}.lock`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      await mkdir(lockPath);
      const owner: LockOwner = { token: randomUUID(), pid: process.pid };
      try {
        await writeLockOwner(lockPath, owner);
      } catch (error) {
        await rm(lockPath, { force: true, recursive: true });
        throw error;
      }
      return {
        trackBuild: async (childPid) => {
          owner.childPid = childPid;
          if (process.platform !== "win32") owner.processGroupId = childPid;
          await writeLockOwner(lockPath, owner);
        },
        release: async () => {
          try {
            const current = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")) as Partial<LockOwner>;
            if (current.token === owner.token) await rm(lockPath, { force: true, recursive: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
          }
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await lockOwnerIsGone(lockPath)) {
        await reclaimStaleLock(lockPath);
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting ${LOCK_WAIT_MS}ms for public package build lock at ${lockPath}`);
      await pause(LOCK_RETRY_MS);
    }
  }
};

const endGate = async (gate: NodeJS.WritableStream): Promise<void> => new Promise((resolve, reject) => {
  gate.once("error", reject);
  gate.end("build\n", resolve);
});

const isWritableGate = (stream: NodeJS.ReadableStream | NodeJS.WritableStream | null | undefined): stream is NodeJS.WritableStream =>
  stream !== null && stream !== undefined && "end" in stream && typeof stream.end === "function";

const terminateBuild = (child: ReturnType<typeof spawn>): void => {
  if (child.pid === undefined) return;
  if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
  else child.kill("SIGTERM");
};

const runBuild = async (packageRoot: string, lock: PublicPackageBuildLock, testHooks?: PublicPackageBuildTestHooks): Promise<void> => {
  // The shell is the detached group leader and execs npm after the parent has
  // atomically recorded that PID/group in owner.json.  If the parent dies while
  // the gate is closed, EOF makes the shell exit without starting a build.
  const posixGate = process.platform !== "win32";
  const child = posixGate
    ? spawn("/bin/sh", ["-c", "IFS= read -r _ <&3 || exit 97; exec npm run build"], { cwd: packageRoot, detached: true, stdio: ["ignore", "inherit", "inherit", "pipe"] })
    : spawn("npm", ["run", "build"], { cwd: packageRoot, detached: false, stdio: "inherit" });
  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`npm run build failed (${signal ? `signal ${signal}` : `exit ${code}`})`));
    });
  });
  try {
    if (posixGate) await testHooks?.afterGatedChildSpawned?.();
    await lock.trackBuild(child.pid!);
    if (posixGate) await testHooks?.afterOwnerRecordedBeforeGate?.();
    if (posixGate) {
      const gate = child.stdio[3];
      if (!isWritableGate(gate)) throw new Error("public package build gate was not created");
      await endGate(gate);
      await testHooks?.afterGateOpened?.();
    }
  } catch (error) {
    terminateBuild(child);
    await completed.catch(() => undefined);
    throw error;
  }
  await completed;
};

/** Serializes and validates physical package builds requested by public-surface tests. */
export const ensurePublicPackageBuild = async (packageRoot: string, testHooks?: PublicPackageBuildTestHooks): Promise<void> => {
  const resolvedRoot = path.resolve(packageRoot);
  const lock = await acquireBuildLock(resolvedRoot);
  try {
    if (await hasSuccessfulBuild(resolvedRoot)) return;
    const beforeBuild = await buildInputDigest(resolvedRoot);
    await runBuild(resolvedRoot, lock, testHooks);
    const afterBuild = await buildInputDigest(resolvedRoot);
    if (beforeBuild !== afterBuild) throw new Error("public package build inputs changed while npm run build was running");
    await writeBuildMarker(resolvedRoot, afterBuild);
  } finally {
    await lock.release();
  }
};
