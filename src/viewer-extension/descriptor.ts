import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

const descriptorVersion = "simfile.viewer-extension.v1";
const safeId = /^[a-z][a-z0-9-]{0,63}$/u;

export interface ViewerExtensionMount {
  readonly assetFiles: Readonly<Record<string, string>>;
  readonly assetRoot: string;
  readonly assetTreeSha256: string;
  readonly descriptorPath: string;
  readonly id: string;
  readonly modulePath: string;
  readonly moduleSha256: string;
}

const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && expected.every((key, index) => actual[index] === key);
};

const regularFile = async (candidate: string, label: string): Promise<string> => {
  const resolved = path.resolve(candidate);
  const details = await lstat(resolved);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new TypeError(`${label} must be a regular non-symlink file`);
  }
  return realpath(resolved);
};

const regularDirectory = async (
  candidate: string,
  label: string,
): Promise<string> => {
  const resolved = path.resolve(candidate);
  const details = await lstat(resolved);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new TypeError(`${label} must be a regular non-symlink directory`);
  }
  return realpath(resolved);
};

const assetFiles = async (
  root: string,
  directory = root,
): Promise<Readonly<Record<string, string>>> => {
  const files: Array<readonly [string, string]> = [];
  for (const entry of (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const candidate = path.join(directory, entry.name);
    const details = await lstat(candidate);
    if (details.isSymbolicLink()) {
      throw new TypeError("viewer extension asset tree must not contain symlinks");
    }
    if (details.isDirectory()) {
      Object.entries(await assetFiles(root, candidate)).forEach(([name, digest]) =>
        files.push([name, digest]));
      continue;
    }
    if (!details.isFile()) {
      throw new TypeError("viewer extension asset tree must contain only regular files");
    }
    const relative = path.relative(root, candidate).split(path.sep).join("/");
    files.push([relative, sha256(await readFile(candidate))]);
  }
  return Object.freeze(Object.fromEntries(files.sort(([left], [right]) =>
    left.localeCompare(right))));
};

export const viewerExtensionAssetTreeSha256 = (
  files: Readonly<Record<string, string>>,
): string => sha256(Object.entries(files).sort(([left], [right]) =>
  left.localeCompare(right)).map(([name, digest]) => `${name}\0${digest}\n`).join(""));

export async function loadViewerExtensionDescriptors(
  descriptors: readonly string[],
): Promise<readonly ViewerExtensionMount[]> {
  const mounts: ViewerExtensionMount[] = [];
  const ids = new Set<string>();
  for (const descriptorInput of descriptors) {
    const descriptorPath = await regularFile(
      descriptorInput,
      "viewer extension descriptor",
    );
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(descriptorPath, "utf8"));
    } catch {
      throw new TypeError("viewer extension descriptor must be valid JSON");
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TypeError("viewer extension descriptor must be an object");
    }
    const descriptor = raw as Record<string, unknown>;
    if (!exactKeys(descriptor, ["asset_root", "id", "module", "version"])
      || descriptor.version !== descriptorVersion
      || typeof descriptor.id !== "string"
      || !safeId.test(descriptor.id)
      || ids.has(descriptor.id)
      || typeof descriptor.module !== "string"
      || typeof descriptor.asset_root !== "string") {
      throw new TypeError("invalid viewer extension descriptor");
    }
    const owner = path.dirname(descriptorPath);
    const modulePath = await regularFile(
      path.resolve(owner, descriptor.module),
      "viewer extension module",
    );
    const assetRoot = await regularDirectory(
      path.resolve(owner, descriptor.asset_root),
      "viewer extension asset root",
    );
    const moduleSha256 = sha256(await readFile(modulePath));
    const assets = await assetFiles(assetRoot);
    ids.add(descriptor.id);
    mounts.push(Object.freeze({
      assetFiles: assets,
      assetRoot,
      assetTreeSha256: viewerExtensionAssetTreeSha256(assets),
      descriptorPath,
      id: descriptor.id,
      modulePath,
      moduleSha256,
    }));
  }
  return Object.freeze(mounts);
}
