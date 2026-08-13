import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { DYNAMICS_BUILD_CONTRACT } from "./buildInput.js";
import { DYNAMICS_LIMITS } from "./limits.js";

export interface ResolvedDynamicsModule {
  absolutePath: string;
  module: string;
  moduleSha256: string;
  projectRoot: string;
}

const isContained = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};

const validateModuleReference = (moduleReference: string): string[] => {
  if (typeof moduleReference !== "string") {
    throw new Error("dynamics.module must be a portable ./ project-relative .ts or .mjs path");
  }
  const hasAllowedExtension = DYNAMICS_BUILD_CONTRACT.allowedExtensions
    .some((extension) => moduleReference.endsWith(extension));
  if (
    moduleReference.length > DYNAMICS_LIMITS.identifier_code_units
    || !moduleReference.startsWith("./")
    || moduleReference.includes("\\")
    || moduleReference.includes("\0")
    || moduleReference.includes("?")
    || moduleReference.includes("#")
    || !hasAllowedExtension
  ) {
    throw new Error("dynamics.module must be a portable ./ project-relative .ts or .mjs path");
  }
  const segments = moduleReference.slice(2).split("/");
  const leaf = segments.at(-1);
  if (
    leaf === undefined
    || leaf.endsWith(".d.ts")
    || segments.some((segment) => !/^[A-Za-z0-9._-]+$/u.test(segment) || segment === "." || segment === "..")
  ) {
    throw new Error("dynamics.module must contain only portable path segments");
  }
  return segments;
};

/**
 * Resolves only the declared entry point. The module remains trusted project
 * code: this does not restrict its imports, I/O, environment, or network use.
 */
export const resolveDynamicsModule = async (
  simfilePath: string,
  moduleReference: string
): Promise<ResolvedDynamicsModule> => {
  const segments = validateModuleReference(moduleReference);
  const absoluteSimfile = path.resolve(simfilePath);
  const simfileStat = await lstat(absoluteSimfile);
  if (simfileStat.isSymbolicLink() || !simfileStat.isFile()) {
    throw new Error(`Simfile path must be a regular non-symlink file: ${simfilePath}`);
  }

  const projectRoot = await realpath(path.dirname(absoluteSimfile));
  let current = projectRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index] as string);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`dynamics.module must not contain symlinks: ${moduleReference}`);
    }
    const isLeaf = index === segments.length - 1;
    if ((!isLeaf && !stat.isDirectory()) || (isLeaf && !stat.isFile())) {
      throw new Error(`dynamics.module must resolve to a regular file: ${moduleReference}`);
    }
  }

  const absolutePath = await realpath(current);
  if (!isContained(projectRoot, absolutePath)) {
    throw new Error(`dynamics.module escapes the Simfile project: ${moduleReference}`);
  }
  const source = await readFile(absolutePath);
  return {
    absolutePath,
    module: `./${segments.join("/")}`,
    moduleSha256: createHash("sha256").update(source).digest("hex"),
    projectRoot
  };
};
