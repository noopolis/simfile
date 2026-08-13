import { access, readFile } from "node:fs/promises";
import path from "node:path";

import {
  parseProjectViewerExtensions,
  type ProjectViewerExtensionDeclaration,
} from "../viewer-extension/projectDeclaration.js";
import {
  loadViewerExtensionDescriptors,
  type ViewerExtensionMount,
} from "./viewerExtensions.js";

export interface RunViewerExtensionsOptions {
  readonly explicitDescriptors: readonly string[];
  readonly ignoreRecorded: boolean;
  readonly runDir: string;
  readonly trustedRoot?: string;
}

export interface RunViewerExtensionIdentity {
  readonly id: string;
  readonly status: "recorded" | "unsealed/local";
}

export interface RunViewerExtensionPlan {
  readonly identities: readonly RunViewerExtensionIdentity[];
  readonly mounts: readonly ViewerExtensionMount[];
  readonly reconcileAtSeal?: () => Promise<readonly RunViewerExtensionIdentity[]>;
}

interface TrustedMount {
  readonly expectedDescriptor?: string;
  readonly mount: ViewerExtensionMount;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isMissing = (error: unknown): boolean =>
  isObject(error) && error.code === "ENOENT";

const inside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === ""
    || !(relative === ".." || relative.startsWith(`..${path.sep}`));
};

const causeMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const recordedFailure = (file: string, error: unknown): Error => new Error(
  `Recorded viewer extension verification failed for ${file}: ${causeMessage(error)}\n`
  + "Build the trusted local simulation project, then retry from that project directory. "
  + "To start without recorded viewer extensions, pass "
  + "`--ignore-recorded-viewer-extensions`.",
);

const recordedDeclaration = async (
  runDir: string,
): Promise<readonly ProjectViewerExtensionDeclaration[] | undefined> => {
  const declarationPath = path.join(path.resolve(runDir), "viewer-extensions.json");
  let bytes: Uint8Array;
  try {
    bytes = await readFile(declarationPath);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw recordedFailure(declarationPath, error);
  }
  try {
    return parseProjectViewerExtensions(bytes, declarationPath).extensions;
  } catch (error) {
    throw recordedFailure(declarationPath, error);
  }
};

const localDeclaration = async (
  trustedRoot: string,
): Promise<readonly ProjectViewerExtensionDeclaration[]> => {
  const declarationPath = path.join(trustedRoot, "viewer-extensions.json");
  let bytes: Uint8Array;
  try {
    bytes = await readFile(declarationPath);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const declarations = parseProjectViewerExtensions(bytes, declarationPath).extensions;
  if (declarations.some(({ asset_tree_sha256, module_sha256 }) =>
    asset_tree_sha256 !== undefined || module_sha256 !== undefined)) {
    throw new TypeError("trusted project viewer extension declarations must not contain recorded digests");
  }
  return declarations;
};

const descriptorToken = (trustedRoot: string, descriptorPath: string): string | undefined => {
  const relative = path.relative(trustedRoot, descriptorPath);
  if (!inside(trustedRoot, descriptorPath) || relative.length === 0) return undefined;
  return `./${relative.split(path.sep).join("/")}`;
};

const trustedMounts = async (
  trustedRootInput: string,
  explicitDescriptors: readonly string[],
  includeProjectDeclaration = true,
): Promise<readonly TrustedMount[]> => {
  const trustedRoot = path.resolve(trustedRootInput);
  const declarations = includeProjectDeclaration
    ? await localDeclaration(trustedRoot)
    : [];
  const trusted: TrustedMount[] = [];
  for (const declaration of declarations) {
    const descriptorPath = path.resolve(trustedRoot, declaration.descriptor);
    if (!inside(trustedRoot, descriptorPath)) {
      throw new TypeError("trusted viewer extension descriptor escapes the project directory");
    }
    const [mount] = await loadViewerExtensionDescriptors([descriptorPath]);
    if (mount?.id !== declaration.id) {
      throw new TypeError("trusted viewer extension id does not match its descriptor");
    }
    trusted.push({ expectedDescriptor: declaration.descriptor, mount });
  }
  const explicit = await loadViewerExtensionDescriptors(explicitDescriptors);
  for (const mount of explicit) {
    const existing = trusted.find(({ mount: candidate }) => candidate.id === mount.id);
    if (existing !== undefined) {
      if (existing.mount.descriptorPath !== mount.descriptorPath) {
        throw new TypeError(`duplicate viewer extension id: ${mount.id}`);
      }
      continue;
    }
    trusted.push({
      expectedDescriptor: descriptorToken(trustedRoot, mount.descriptorPath),
      mount,
    });
  }
  return Object.freeze(trusted);
};

const sameMount = (left: ViewerExtensionMount, right: ViewerExtensionMount): boolean =>
  left.id === right.id
  && left.descriptorPath === right.descriptorPath
  && left.moduleSha256 === right.moduleSha256
  && left.assetTreeSha256 === right.assetTreeSha256;

const verifyRecorded = async (
  declarations: readonly ProjectViewerExtensionDeclaration[],
  startup: readonly TrustedMount[],
): Promise<readonly RunViewerExtensionIdentity[]> => {
  if (declarations.length !== startup.length) {
    throw new Error("recorded viewer extensions do not match the trusted local mapping");
  }
  for (const trusted of startup) {
    const recorded = declarations.find(({ id }) => id === trusted.mount.id);
    if (recorded === undefined || trusted.expectedDescriptor === undefined
      || recorded.descriptor !== trusted.expectedDescriptor
      || recorded.module_sha256 === undefined
      || recorded.asset_tree_sha256 === undefined
      || recorded.module_sha256 !== trusted.mount.moduleSha256
      || recorded.asset_tree_sha256 !== trusted.mount.assetTreeSha256) {
      throw new Error(`recorded viewer extension ${trusted.mount.id} does not corroborate its trusted local mapping`);
    }
    const [current] = await loadViewerExtensionDescriptors([trusted.mount.descriptorPath]);
    if (current === undefined || !sameMount(trusted.mount, current)) {
      throw new Error(`trusted viewer extension ${trusted.mount.id} changed after startup`);
    }
  }
  return Object.freeze(startup.map(({ mount }) => ({
    id: mount.id,
    status: "recorded" as const,
  })));
};

const isSealed = async (runDir: string): Promise<boolean> => {
  try {
    await access(path.join(path.resolve(runDir), "manifest.json"));
    return true;
  } catch {
    return false;
  }
};

export const loadRunViewerExtensions = async (
  options: RunViewerExtensionsOptions,
): Promise<readonly ViewerExtensionMount[]> =>
  (await loadRunViewerExtensionPlan(options)).mounts;

/**
 * Recorded declarations are data, never code-loading authority. Modules are
 * loaded only from the caller-selected local project or explicit descriptors;
 * a sealed declaration can only corroborate those startup bytes and paths.
 */
export const loadRunViewerExtensionPlan = async (
  options: RunViewerExtensionsOptions,
): Promise<RunViewerExtensionPlan> => {
  const trustedRoot = path.resolve(options.trustedRoot ?? process.cwd());
  const trusted = await trustedMounts(
    trustedRoot,
    options.explicitDescriptors,
    !options.ignoreRecorded,
  );
  const mounts = Object.freeze(trusted.map(({ mount }) => mount));
  if (options.ignoreRecorded) return {
    mounts,
    identities: mounts.map(({ id }) => ({ id, status: "unsealed/local" })),
  };

  const declarations = await recordedDeclaration(options.runDir);
  if (declarations !== undefined) {
    return Object.freeze({
      mounts,
      identities: await verifyRecorded(declarations, trusted),
    });
  }
  if (await isSealed(options.runDir)) {
    if (trusted.length > 0) {
      throw recordedFailure(
        path.join(path.resolve(options.runDir), "viewer-extensions.json"),
        new Error("sealed run has no recorded viewer extension declaration"),
      );
    }
    return Object.freeze({ mounts, identities: [] });
  }

  return Object.freeze({
    mounts,
    identities: Object.freeze(mounts.map(({ id }) => ({
      id,
      status: "unsealed/local" as const,
    }))),
    reconcileAtSeal: async () => {
      const sealed = await recordedDeclaration(options.runDir);
      if (sealed === undefined) {
        throw new Error("sealed run did not record a viewer extension declaration");
      }
      return verifyRecorded(sealed, trusted);
    },
  });
};
