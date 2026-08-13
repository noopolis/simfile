import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from "../dynamics/buildIdentity.js";
import { parseWorldSidecarAbsolutePath } from "./sidecarPath.js";
import { scopedSecretMountPath } from "./secretMount.js";

type RootAuthority = Readonly<{ root: string; dev: number; ino: number; handle: FileHandle }>;
export interface WorldSidecarSecretReadHooks {
  /** Test seam only; receives no path, authority, or secret value. */
  onStage?(stage: "before_open" | "before_read"): void | Promise<void>;
}
export interface WorldSidecarActivationExpectation {
  readonly bundle_digest: string;
  readonly run_id: string;
}
export interface WorldSidecarActivationWatcher {
  /** Resolves only after exact owner-authored marker bytes are observed. */
  readonly ready: Promise<void>;
  close(): Promise<void>;
}
export const WORLD_SIDECAR_ACTIVATION_RELATIVE_PATH =
  ".spawnfile/world-service-activated.v1" as const;
const same = (left: Readonly<{ dev: number; ino: number }>, right: Readonly<{ dev: number; ino: number }>): boolean =>
  left.dev === right.dev && left.ino === right.ino;
const fail = (): never => { throw new Error("world sidecar filesystem operation failed"); };
const regular = (value: Readonly<{ isFile(): boolean; isSymbolicLink(): boolean; nlink: number }>): void => {
  if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1) fail();
};
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const assertAncestors = async (absolute: string, create: boolean): Promise<void> => {
  const parsed = path.parse(absolute); let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) fail();
      await mkdir(current, { mode: 0o700 });
      const created = await lstat(current);
      if (!created.isDirectory() || created.isSymbolicLink()) fail();
    }
  }
};

export const openWorldSidecarRoot = async (value: unknown, create: boolean): Promise<RootAuthority> => {
  const root = parseWorldSidecarAbsolutePath(value);
  await assertAncestors(root, create);
  if (await realpath(root) !== root) fail();
  const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const stat = await handle.stat();
  if (!stat.isDirectory()) { await handle.close(); return fail(); }
  const authority = Object.freeze({ root, dev: stat.dev, ino: stat.ino, handle });
  const observed = await lstat(root);
  if (!same(authority, observed) || observed.isSymbolicLink()) { await handle.close(); return fail(); }
  return authority;
};

const verifyRoot = async (authority: RootAuthority): Promise<void> => {
  const [pathStat, handleStat] = await Promise.all([lstat(authority.root), authority.handle.stat()]);
  if (pathStat.isSymbolicLink() || !pathStat.isDirectory() || !handleStat.isDirectory()
    || !same(authority, pathStat) || !same(authority, handleStat)) fail();
};

export const readWorldSidecarSecret = async (
  authority: RootAuthority,
  scope: string,
  name: string,
  hooks: WorldSidecarSecretReadHooks = {},
): Promise<string> => {
  await verifyRoot(authority);
  const relative = scopedSecretMountPath(scope, name);
  if (relative === undefined) return fail();
  const scopePath = path.join(authority.root, scope);
  const candidate = path.join(authority.root, relative);
  if (path.dirname(candidate) !== scopePath || path.dirname(scopePath) !== authority.root) fail();
  const scopeHandle = await open(scopePath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let handle: FileHandle | undefined;
  try {
    const [scopeStat, observedScope] = await Promise.all([scopeHandle.stat(), lstat(scopePath)]);
    if (!scopeStat.isDirectory() || !observedScope.isDirectory() || observedScope.isSymbolicLink() || !same(scopeStat, observedScope)) fail();
    const preOpenCandidate = await lstat(candidate); regular(preOpenCandidate);
    await hooks.onStage?.("before_open");
    handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    // Node lacks openat(2), so bind every pathname authority to the held
    // descriptor before reading. Any replacement fails before the bearer is
    // returned, including a replacement made between lstat and open.
    await verifyRoot(authority);
    const [boundScope, boundScopePath, boundCandidate, handleStat] = await Promise.all([
      scopeHandle.stat(), lstat(scopePath), lstat(candidate), handle.stat(),
    ]);
    if (!boundScope.isDirectory() || !boundScopePath.isDirectory() || boundScopePath.isSymbolicLink() || !same(boundScope, boundScopePath)) fail();
    regular(boundCandidate); regular(handleStat);
    if (!same(preOpenCandidate, handleStat) || !same(boundCandidate, handleStat)
      || handleStat.size < 1 || handleStat.size > 1025) fail();
    await hooks.onStage?.("before_read");
    const bytes = new Uint8Array(1026); const read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== handleStat.size || read.bytesRead > 1025) fail();
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, read.bytesRead));
    const bearer = source.endsWith("\n") ? source.slice(0, -1) : source;
    if (!/^[^\u0000-\u0020\u007f]{1,1024}$/u.test(bearer)) fail();
    const [recheckedScope, recheckedScopePath, recheckedCandidate, recheckedHandle] = await Promise.all([
      scopeHandle.stat(), lstat(scopePath), lstat(candidate), handle.stat(),
    ]);
    if (!recheckedScope.isDirectory() || !recheckedScopePath.isDirectory() || recheckedScopePath.isSymbolicLink() || !same(recheckedScope, recheckedScopePath)) fail();
    regular(recheckedCandidate); regular(recheckedHandle);
    if (!same(recheckedCandidate, recheckedHandle) || !same(handleStat, recheckedHandle)) fail();
    await verifyRoot(authority);
    return bearer;
  } catch { return fail(); } finally { await handle?.close().catch(() => {}); await scopeHandle.close().catch(() => {}); }
};

const verifyCommittedEvidence = async (
  authority: RootAuthority,
  final: string,
  bytes: Uint8Array,
): Promise<void> => {
  await verifyRoot(authority);
  const [pathStat, handle] = await Promise.all([
    lstat(final),
    open(final, constants.O_RDONLY | constants.O_NOFOLLOW),
  ]);
  try {
    const handleStat = await handle.stat();
    regular(pathStat); regular(handleStat);
    if (!same(pathStat, handleStat) || (handleStat.mode & 0o777) !== 0o644
      || handleStat.size !== bytes.byteLength) fail();
    const observed = await handle.readFile();
    if (observed.byteLength !== bytes.byteLength
      || !observed.every((byte, index) => byte === bytes[index])) fail();
  } finally {
    await handle.close();
  }
  await verifyRoot(authority);
};

/**
 * Atomically publishes evidence. An exact prior publication is a recoverable,
 * idempotent retry; a different or hostile prior file fails closed.
 *
 * The return value is true only when this call created the final file.
 */
export const commitWorldSidecarEvidence = async (
  authority: RootAuthority,
  bytes: Uint8Array,
): Promise<boolean> => {
  if (bytes.byteLength < 1 || bytes.byteLength > 4096) fail();
  await verifyRoot(authority);
  const final = path.join(authority.root, "world-sidecar.json");
  const temporary = path.join(authority.root, `.world-sidecar-${randomUUID()}.tmp`);
  let handle: FileHandle | undefined; let linked = false;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    await handle.writeFile(bytes); await handle.sync();
    const temporaryStat = await handle.stat();
    if (!temporaryStat.isFile() || temporaryStat.nlink !== 1 || (temporaryStat.mode & 0o777) !== 0o644 || temporaryStat.size !== bytes.byteLength) fail();
    try {
      await link(temporary, final); linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await verifyCommittedEvidence(authority, final, bytes);
      return false;
    }
    const finalHandle = await open(final, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const finalStat = await finalHandle.stat();
      if (!finalStat.isFile() || finalStat.nlink !== 2 || (finalStat.mode & 0o777) !== 0o644 || !same(temporaryStat, finalStat)) fail();
      const observed = await finalHandle.readFile();
      if (observed.byteLength !== bytes.byteLength || !observed.every((byte, index) => byte === bytes[index])) fail();
    } finally { await finalHandle.close(); }
    await verifyRoot(authority);
    await unlink(temporary);
    const committed = await lstat(final);
    if (!committed.isFile() || committed.isSymbolicLink() || committed.nlink !== 1 || (committed.mode & 0o777) !== 0o644) fail();
    linked = false;
    return true;
  } catch {
    if (linked) await unlink(final).catch(() => {});
    return fail();
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
};

/** Removes only the exact evidence publication owned by a failed startup. */
export const removeWorldSidecarEvidence = async (
  authority: RootAuthority,
  expectedBytes: Uint8Array,
): Promise<void> => {
  if (expectedBytes.byteLength < 1 || expectedBytes.byteLength > 4096) fail();
  const final = path.join(authority.root, "world-sidecar.json");
  await verifyCommittedEvidence(authority, final, expectedBytes);
  await unlink(final);
  await verifyRoot(authority);
};

const readActivationMarker = async (
  authority: RootAuthority,
  expected: WorldSidecarActivationExpectation,
): Promise<boolean> => {
  await verifyRoot(authority);
  const directory = path.join(authority.root, ".spawnfile");
  const candidate = path.join(authority.root, WORLD_SIDECAR_ACTIVATION_RELATIVE_PATH);
  let directoryPathStat;
  try {
    directoryPathStat = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return fail();
  }
  if (!directoryPathStat.isDirectory() || directoryPathStat.isSymbolicLink()) fail();
  const directoryHandle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let markerHandle: FileHandle | undefined;
  try {
    const directoryHandleStat = await directoryHandle.stat();
    if (!directoryHandleStat.isDirectory()
      || !same(directoryPathStat, directoryHandleStat)) fail();
    let markerPathStat;
    try {
      markerPathStat = await lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      return fail();
    }
    regular(markerPathStat);
    markerHandle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const [boundRoot, boundDirectory, boundDirectoryPath, boundMarkerPath, markerStat] =
      await Promise.all([
        authority.handle.stat(),
        directoryHandle.stat(),
        lstat(directory),
        lstat(candidate),
        markerHandle.stat(),
      ]);
    if (!boundRoot.isDirectory() || !same(authority, boundRoot)
      || !boundDirectory.isDirectory() || !boundDirectoryPath.isDirectory()
      || boundDirectoryPath.isSymbolicLink()
      || !same(boundDirectory, boundDirectoryPath)) fail();
    regular(boundMarkerPath); regular(markerStat);
    if (!same(boundMarkerPath, markerStat)
      || (markerStat.mode & 0o777) !== 0o644
      || markerStat.size < 1 || markerStat.size > 4096) fail();
    const bytes = await markerHandle.readFile();
    if (bytes.byteLength !== markerStat.size) fail();
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const raw = JSON.parse(source) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)
      || Object.getPrototypeOf(raw) !== Object.prototype) fail();
    const fields = [
      "bundle_digest", "run_id", "state", "topology_receipt_digest",
      "topology_request_digest", "version",
    ] as const;
    const marker = raw as Record<string, unknown>;
    const keys = Object.keys(marker).sort();
    const expectedFields = [...fields].sort();
    if (keys.length !== fields.length
      || keys.some((key, index) => key !== expectedFields[index])) fail();
    if (marker.version !== "spawnfile.world-service-activation.v1"
      || marker.state !== "activated"
      || marker.run_id !== expected.run_id
      || marker.bundle_digest !== expected.bundle_digest
      || !SHA256.test(String(marker.topology_request_digest))
      || !SHA256.test(String(marker.topology_receipt_digest))
      || source !== `${canonicalJson(marker)}\n`) fail();
    const [finalRoot, finalDirectory, finalDirectoryPath, finalMarkerPath, finalMarker] =
      await Promise.all([
        authority.handle.stat(),
        directoryHandle.stat(),
        lstat(directory),
        lstat(candidate),
        markerHandle.stat(),
      ]);
    if (!same(boundRoot, finalRoot)
      || !same(boundDirectory, finalDirectory)
      || !same(boundDirectoryPath, finalDirectoryPath)
      || !same(boundMarkerPath, finalMarkerPath)
      || !same(markerStat, finalMarker)) fail();
    await verifyRoot(authority);
    return true;
  } catch {
    return fail();
  } finally {
    await markerHandle?.close().catch(() => {});
    await directoryHandle.close().catch(() => {});
  }
};

/**
 * Observes Spawnfile's owner-only activation marker. Polling schedules
 * observation only: elapsed time can never release the world controller.
 */
export const watchWorldSidecarActivation = (
  authority: RootAuthority,
  expected: WorldSidecarActivationExpectation,
): WorldSidecarActivationWatcher => {
  if (!SHA256.test(expected.bundle_digest) || !RUN_ID.test(expected.run_id)
    || Buffer.byteLength(expected.run_id, "utf8") > 128) fail();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: Promise<void> = Promise.resolve();
  let resolveReady = (): void => {};
  let rejectReady = (_error: Error): void => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const inspect = (): void => {
    if (stopped) return;
    current = readActivationMarker(authority, expected).then((activated) => {
      if (stopped) return;
      if (activated) {
        stopped = true;
        resolveReady();
        return;
      }
      timer = setTimeout(inspect, 25);
    }, () => {
      stopped = true;
      rejectReady(new Error("world sidecar activation failed"));
    });
  };
  inspect();
  return Object.freeze({
    ready,
    close: async () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await current.catch(() => {});
    },
  });
};

export const closeWorldSidecarRoot = async (authority: RootAuthority | undefined): Promise<void> => {
  await authority?.handle.close();
};
