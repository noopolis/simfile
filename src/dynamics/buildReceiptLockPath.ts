import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { compareUtf16 } from "./buildIdentity.js";

const fail = (message: string): never => { throw new Error(message); };

export const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

export const compareMaps = (left: Record<string, string>, right: Record<string, string>, label: string): void => {
  const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) => compareUtf16(leftKey, rightKey));
  const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) => compareUtf16(leftKey, rightKey));
  if (leftEntries.length !== rightEntries.length) fail(`lock root dependency drift: ${label}`);
  for (let index = 0; index < leftEntries.length; index += 1) {
    const [leftKey, leftValue] = leftEntries[index];
    const [rightKey, rightValue] = rightEntries[index];
    if (leftKey !== rightKey || leftValue !== rightValue) fail(`lock root dependency drift: ${label}`);
  }
};

export const asObject = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label}: expected object`);
  return value as Record<string, unknown>;
};

export const asString = (value: unknown, label: string): string => {
  const text = typeof value === "string" ? value : fail(`${label}: expected non-empty string`);
  if (text.length === 0) fail(`${label}: expected non-empty string`);
  return text;
};

export const asBoolean = (value: unknown, label: string): boolean | null => {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value;
  fail(`${label}: expected boolean`);
  return null;
};

export const asDefined = <T>(value: T | undefined, label: string): T => {
  if (value === undefined) fail(label);
  return value as T;
};

export const asDependencyMap = (value: unknown, label: string): Record<string, string> => {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label}: expected map`);

  const output: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    output[key] = asString(raw, `${label}.${key}`);
  }
  return output;
};

export const parseJson = (value: string, filePath: string): Record<string, unknown> => {
  try {
    return asObject(JSON.parse(value), filePath);
  } catch (_error) {
    return fail(`malformed JSON: ${filePath}`);
  }
};

const hasControlCharacter = (value: string): boolean => {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined || code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
};

const isPortablePathSegment = (value: string): boolean => {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return true;
  if (/^[A-Za-z]:$/.test(value)) return true;
  return false;
};

export const assertPortablePath = (value: string, label: string): void => {
  if (value.includes("\\")) fail(`${label}: unsafe path`);
  if (value.includes("\0")) fail(`${label}: unsafe path`);
  if (hasControlCharacter(value)) fail(`${label}: unsafe path`);
  if (value.includes("?")) fail(`${label}: unsafe path`);
  if (value.includes("#")) fail(`${label}: unsafe path`);
  if (value.includes("://")) fail(`${label}: unsafe path`);
  if (value.length === 0) fail(`${label}: empty path`);
  if (path.isAbsolute(value)) fail(`${label}: absolute path`);

  for (const segment of value.split("/")) {
    if (segment === "" || segment === "." || segment === "..") fail(`${label}: unsafe path`);
    if (isPortablePathSegment(segment)) fail(`${label}: unsafe path`);
  }
};

export const assertRegularPath = async (value: string, label: string, expectsDirectory: boolean): Promise<string> => {
  const absolute = path.resolve(value);
  const root = path.parse(absolute).root;
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
  if (parts.length === 0) fail(`required regular ${expectsDirectory ? "directory" : "file"} missing: ${label}`);

  let cursor = root;
  for (const [index, part] of parts.entries()) {
    cursor = path.join(cursor, part);
    let entry: Awaited<ReturnType<typeof lstat>>;
    try {
      entry = await lstat(cursor);
    } catch (error: unknown) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        fail(`required regular ${expectsDirectory ? "directory" : "file"} missing: ${label}`);
      }
      throw error;
    }

    if (entry.isSymbolicLink()) fail(`forbidden symlink path: ${label}`);
    if (index === parts.length - 1) {
      if (expectsDirectory ? !entry.isDirectory() : !entry.isFile()) {
        fail(`non-${expectsDirectory ? "directory" : "file"} path: ${label}`);
      }
      continue;
    }
    if (!entry.isDirectory()) fail(`non-directory path component: ${label}`);
  }
  return absolute;
};

export const assertRegularFile = (value: string, label: string): Promise<string> => assertRegularPath(value, label, false);
export const assertRegularDirectory = (value: string, label: string): Promise<string> => assertRegularPath(value, label, true);

export const readRegularFile = async (filePath: string, label: string): Promise<Buffer> => {
  const regular = await assertRegularFile(filePath, label);
  return readFile(regular);
};

export const readPackageIdentity = async (manifestPath: string): Promise<{ readonly name: string; readonly version: string; readonly sha256: string; }> => {
  const raw = await readRegularFile(manifestPath, manifestPath);
  const json = parseJson(raw.toString("utf8"), manifestPath);
  return {
    name: asString(json.name, `${manifestPath}:name`),
    version: asString(json.version, `${manifestPath}:version`),
    sha256: sha256(raw)
  };
};

export const readPackageName = async (packageRoot: string): Promise<string> => {
  const packageJsonPath = path.join(packageRoot, "package.json");
  const raw = await readRegularFile(packageJsonPath, `${packageRoot}/package.json`);
  const json = parseJson(raw.toString("utf8"), packageJsonPath);
  return asString(json.name, `${packageJsonPath}:name`);
};

export const assertInsideRoot = (root: string, target: string, label: string): void => {
  const rel = path.relative(root, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) fail(`path escapes root: ${label}`);
};

export const ensureNoSymlink = (base: string, value: string, label: string): string => {
  const absolute = path.resolve(base, value);
  assertInsideRoot(base, absolute, label);
  return absolute;
};

export const toPortable = (value: string): string => value.split(path.sep).join("/");
