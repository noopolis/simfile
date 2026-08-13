import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

export const withTemp = async <T>(callback: (root: string) => Promise<T>): Promise<T> => {
  const tmpRoot = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(tmpRoot, "simfile-b62-"));
  try {
    return await callback(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

export const writeJson = async (filePath: string, value: unknown): Promise<void> => {
  await writeFile(filePath, JSON.stringify(value), "utf8");
};

export const createPackageManifest = async (
  packageRoot: string,
  name: string,
  version: string,
  extra: Record<string, unknown> = {}
): Promise<string> => {
  await mkdir(packageRoot, { recursive: true });
  const manifest = { name, version, ...extra };
  const raw = JSON.stringify(manifest);
  await writeFile(path.join(packageRoot, "package.json"), raw, "utf8");
  return sha256(raw);
};

export const writeSourceFile = async (filePath: string, value: string): Promise<string> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, "utf8");
  return sha256(value);
};

export const createLockFile = async (
  root: string,
  rootName: string,
  rootVersion: string,
  entries: ReadonlyArray<{
    readonly path: string;
    readonly version?: string;
    readonly name?: string;
    readonly resolved?: string;
    readonly link?: boolean;
  }>,
  rootDependencies: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  } = {}
): Promise<void> => {
  const packageEntries: Record<string, {
    name?: string;
    version?: string;
    resolved?: string;
    link?: boolean;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  }> = {
    "": {
      name: rootName,
      version: rootVersion,
      dependencies: rootDependencies.dependencies,
      devDependencies: rootDependencies.devDependencies,
      optionalDependencies: rootDependencies.optionalDependencies,
      peerDependencies: rootDependencies.peerDependencies
    }
  };
  for (const entry of entries) {
    packageEntries[entry.path] = {
      ...(entry.name === undefined ? {} : { name: entry.name }),
      ...(entry.resolved === undefined ? {} : { resolved: entry.resolved }),
      ...(entry.link === undefined ? {} : { link: entry.link }),
      ...(entry.version === undefined ? {} : { version: entry.version })
    };
  }

  await writeJson(path.join(root, "package-lock.json"), {
    name: rootName,
    version: rootVersion,
    lockfileVersion: 3,
    packages: packageEntries
  });
};

export const createSimfile = async (projectRoot: string): Promise<string> => {
  await mkdir(projectRoot, { recursive: true });
  const simfilePath = path.join(projectRoot, "Simfile");
  await writeFile(simfilePath, "{}", "utf8");
  return simfilePath;
};

export const readFileDigest = async (filePath: string): Promise<string> => sha256(await readFile(filePath));

export const createSymlinkDirectory = async (source: string, destination: string): Promise<void> => {
  await mkdir(path.dirname(destination), { recursive: true });
  await symlink(source, destination);
};

export const createSymlinkFile = async (source: string, destination: string): Promise<void> => {
  await mkdir(path.dirname(destination), { recursive: true });
  await symlink(source, destination);
};
