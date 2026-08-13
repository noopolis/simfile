import { readFile } from "node:fs/promises";
import path from "node:path";

import { stableStringify } from "../ledger/stable.js";
import { loadViewerExtensionDescriptors } from "./descriptor.js";

export const PROJECT_VIEWER_EXTENSIONS_VERSION =
  "simfile.project-viewer-extensions.v1" as const;

export interface ProjectViewerExtensionDeclaration {
  readonly asset_tree_sha256?: string;
  readonly descriptor: string;
  readonly id: string;
  readonly module_sha256?: string;
}

export interface ProjectViewerExtensions {
  readonly extensions: readonly ProjectViewerExtensionDeclaration[];
  readonly version: typeof PROJECT_VIEWER_EXTENSIONS_VERSION;
}

export interface LoadedProjectViewerExtensions {
  readonly bytes: Uint8Array;
  readonly declaration: ProjectViewerExtensions;
  readonly path: string;
}

const safeId = /^[a-z][a-z0-9-]{0,63}$/u;
const sha256 = /^[a-f0-9]{64}$/u;

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && expected.every((key, index) => actual[index] === key);
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const safeDescriptor = (value: string): boolean => {
  if (!value.startsWith("./") || !value.endsWith(".json")) return false;
  if (value.includes("\\") || value.includes("\0")
    || value.includes("?") || value.includes("#")) return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
    || /^[a-z][a-z0-9+.-]*:/iu.test(value)) return false;
  return !value.split("/").includes("..");
};

export const parseProjectViewerExtensions = (
  bytes: Uint8Array,
  source = "viewer-extensions.json",
): ProjectViewerExtensions => {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    throw new TypeError(`${source} must contain valid JSON`);
  }
  if (!isObject(raw)
    || !exactKeys(raw, ["extensions", "version"])
    || raw.version !== PROJECT_VIEWER_EXTENSIONS_VERSION
    || !Array.isArray(raw.extensions)) {
    throw new TypeError(`invalid ${PROJECT_VIEWER_EXTENSIONS_VERSION} declaration in ${source}`);
  }
  const ids = new Set<string>();
  const extensions = raw.extensions.map((value) => {
    if (!isObject(value)) {
      throw new TypeError(`invalid ${PROJECT_VIEWER_EXTENSIONS_VERSION} declaration in ${source}`);
    }
    const sourceShape = exactKeys(value, ["descriptor", "id"]);
    const recordedShape = exactKeys(value, [
      "asset_tree_sha256", "descriptor", "id", "module_sha256",
    ]);
    if ((!sourceShape && !recordedShape)
      || typeof value.id !== "string"
      || !safeId.test(value.id)
      || ids.has(value.id)
      || typeof value.descriptor !== "string"
      || !safeDescriptor(value.descriptor)
      || (recordedShape && (!sha256.test(String(value.module_sha256))
        || !sha256.test(String(value.asset_tree_sha256))))) {
      throw new TypeError(`invalid ${PROJECT_VIEWER_EXTENSIONS_VERSION} declaration in ${source}`);
    }
    ids.add(value.id);
    return Object.freeze({
      descriptor: value.descriptor,
      id: value.id,
      ...(recordedShape ? {
        asset_tree_sha256: value.asset_tree_sha256 as string,
        module_sha256: value.module_sha256 as string,
      } : {}),
    });
  });
  return Object.freeze({
    extensions: Object.freeze(extensions),
    version: PROJECT_VIEWER_EXTENSIONS_VERSION,
  });
};

export const emptyProjectViewerExtensionsBytes = (): Uint8Array =>
  Buffer.from(`${stableStringify({
    version: PROJECT_VIEWER_EXTENSIONS_VERSION,
    extensions: [],
  })}\n`, "utf8");

const isMissing = (error: unknown): boolean =>
  isObject(error) && error.code === "ENOENT";

export const loadProjectViewerExtensions = async (
  simfilePath: string,
): Promise<LoadedProjectViewerExtensions> => {
  const declarationPath = path.join(
    path.dirname(path.resolve(simfilePath)),
    "viewer-extensions.json",
  );
  let bytes: Uint8Array;
  try {
    bytes = await readFile(declarationPath);
  } catch (error) {
    if (!isMissing(error)) throw error;
    bytes = emptyProjectViewerExtensionsBytes();
  }
  return Object.freeze({
    bytes,
    declaration: parseProjectViewerExtensions(bytes, declarationPath),
    path: declarationPath,
  });
};

/** Binds a trusted project declaration to the exact module and asset bytes. */
export const bindProjectViewerExtensions = async (
  loaded: LoadedProjectViewerExtensions,
): Promise<Uint8Array> => {
  const owner = path.dirname(loaded.path);
  const extensions = [];
  for (const declaration of loaded.declaration.extensions) {
    if (declaration.module_sha256 !== undefined
      || declaration.asset_tree_sha256 !== undefined) {
      throw new TypeError("project viewer extension declaration already contains recorded digests");
    }
    const [mount] = await loadViewerExtensionDescriptors([
      path.resolve(owner, declaration.descriptor),
    ]);
    if (mount?.id !== declaration.id) {
      throw new TypeError("project viewer extension id does not match its descriptor");
    }
    extensions.push({
      asset_tree_sha256: mount.assetTreeSha256,
      descriptor: declaration.descriptor,
      id: declaration.id,
      module_sha256: mount.moduleSha256,
    });
  }
  return Buffer.from(`${stableStringify({
    version: PROJECT_VIEWER_EXTENSIONS_VERSION,
    extensions,
  })}\n`, "utf8");
};
