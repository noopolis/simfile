import { lstatSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { compareUtf16 } from "./buildIdentity.js";
import { DYNAMICS_BUILD_PREPARATION_POLICY } from "./buildInput.js";

export interface StaticCompilerReadGuard {
  readonly assertCheckedRead: (fileName: string) => void;
  readonly assertPreflightRead: (fileName: string) => void;
  readonly freezePreflight: () => readonly string[];
  readonly frozenPreflightPaths: () => (readonly string[] | undefined);
  readonly preflightResolutionHost: ts.ModuleResolutionHost;
  readonly checkedResolutionHost: ts.ModuleResolutionHost;
}

const manifestFileName = DYNAMICS_BUILD_PREPARATION_POLICY.package.manifestFileName;
const sourceExtensions = DYNAMICS_BUILD_PREPARATION_POLICY.source.checkedExtensions;

const isContained = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};

const existing = (fileName: string): boolean => {
  try { lstatSync(fileName); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const canonical = (fileName: string): string => path.resolve(fileName);
const isAllowedRead = (fileName: string): boolean => path.basename(fileName) === manifestFileName
  || sourceExtensions.some((extension) => fileName.endsWith(extension));
type LexicalCandidateOutcome = "absent" | "regular";

/**
 * Produces mutable preflight and immutable compiler views from one lexical
 * authority. Neither view realpaths requests, so symlink evidence survives.
 */
export const createStaticCompilerReadGuard = (
  anchors: readonly string[],
  defaultLibraryRoot: string,
  delegate: ts.ModuleResolutionHost = ts.sys
): StaticCompilerReadGuard => {
  const trusted = [...new Set([...anchors, defaultLibraryRoot].map(canonical))].sort((left, right) => {
    const specificity = right.length - left.length;
    return specificity || compareUtf16(left, right);
  });
  const defaultRoot = canonical(defaultLibraryRoot);
  const prevalidated = new Set<string>();
  let frozen: ReadonlySet<string> | undefined;
  let frozenPaths: readonly string[] | undefined;

  const approvedAnchor = (candidate: string): string | undefined =>
    trusted.find((root) => isContained(root, candidate));
  const selectAnchor = (candidate: string): string => {
    const anchor = approvedAnchor(candidate);
    if (!anchor) throw new Error(`TypeScript attempted a read outside approved lexical roots: ${candidate}`);
    return anchor;
  };

  const inspectLexical = (fileName: string, mode: "authorize" | "validate"): LexicalCandidateOutcome => {
    const candidate = canonical(fileName);
    const anchor = selectAnchor(candidate);
    let anchorStat: ReturnType<typeof lstatSync>;
    try { anchorStat = lstatSync(anchor); } catch { throw new Error(`TypeScript cannot safely inspect approved anchor: ${anchor}`); }
    if (anchorStat.isSymbolicLink() || !anchorStat.isDirectory()) {
      throw new Error(`TypeScript approved anchor is not a regular nonsymlink directory: ${anchor}`);
    }
    const fail = (message: string): never => {
      throw new Error(message);
    };
    let current = anchor;
    const relative = path.relative(anchor, candidate).split(path.sep).filter(Boolean);
    if (relative.length === 0) {
      return mode === "authorize" ? "absent" : fail(`TypeScript cannot safely inspect ${candidate}`);
    }
    for (let index = 0; index < relative.length; index += 1) {
      const part = relative[index];
      current = path.join(current, part);
      let stat: ReturnType<typeof lstatSync>;
      try { stat = lstatSync(current); } catch {
        if (mode === "authorize") return "absent";
        throw new Error(`TypeScript cannot safely inspect ${current}`);
      }
      if (mode === "authorize" && (stat.isSymbolicLink() || !stat.isFile() && index === relative.length - 1)) return "absent";
      if (stat.isSymbolicLink()) throw new Error(`static source path contains a symlink before TypeScript read: ${current}`);
      if (index === relative.length - 1) {
        if (!stat.isFile()) {
          throw new Error(`static source path is not a regular file before TypeScript read: ${current}`);
        }
        return "regular";
      }
      if (!stat.isDirectory()) throw new Error(`static source path has a non-directory ancestor before TypeScript read: ${current}`);
    }
    return fail(`TypeScript cannot safely inspect ${candidate}`);
  };

  const assertLexicalRegular = (fileName: string): void => {
    inspectLexical(fileName, "validate");
  };

  const assertPreflightRead = (fileName: string): void => {
    if (frozen) throw new Error("TypeScript preflight evidence is frozen");
    const candidate = canonical(fileName);
    if (!isAllowedRead(candidate)) throw new Error(`TypeScript attempted an unapproved metadata read: ${candidate}`);
    assertLexicalRegular(candidate);
    prevalidated.add(candidate);
  };
  const assertCheckedRead = (fileName: string): void => {
    const candidate = canonical(fileName);
    if (isContained(defaultRoot, candidate)) return assertLexicalRegular(candidate);
    if (!frozen) throw new Error("TypeScript checked read requires frozen preflight evidence");
    if (!frozen.has(candidate)) throw new Error(`TypeScript attempted a compiler read absent from immutable preflight evidence: ${candidate}`);
    assertLexicalRegular(candidate);
  };
  const fileExists = delegate.fileExists?.bind(delegate) ?? ts.sys.fileExists;
  const readFile = delegate.readFile?.bind(delegate) ?? ts.sys.readFile;
  const directoryExists = delegate.directoryExists?.bind(delegate) ?? ts.sys.directoryExists;
  const isCheckedCandidate = (fileName: string): boolean => {
    const candidate = canonical(fileName);
    if (isContained(defaultRoot, candidate)) return inspectLexical(candidate, "authorize") === "regular";
    if (!frozen || !frozen.has(candidate)) return false;
    assertLexicalRegular(candidate);
    return true;
  };
  const resolutionHost = (
    assertRead: (fileName: string) => void,
    isCandidateAuthorized: (candidate: string) => boolean
  ): ts.ModuleResolutionHost => ({
    ...delegate,
    directoryExists,
    fileExists: (fileName) => {
      const candidate = canonical(fileName);
      if (!isCandidateAuthorized(candidate)) return false;
      return fileExists(candidate);
    },
    readFile: (fileName) => {
      assertRead(fileName);
      return readFile(fileName);
    },
    realpath: undefined
  });
  return {
    assertCheckedRead,
    assertPreflightRead,
    freezePreflight: () => {
      if (!frozen) {
        frozenPaths = Object.freeze([...prevalidated].sort(compareUtf16));
        frozen = new Set(frozenPaths);
      }
      return frozenPaths as readonly string[];
    },
    frozenPreflightPaths: () => frozenPaths,
    preflightResolutionHost: resolutionHost(assertPreflightRead, (candidate) => {
      if (!approvedAnchor(candidate)) return false;
      if (!existing(candidate)) return false;
      assertPreflightRead(candidate);
      return true;
    }),
    checkedResolutionHost: resolutionHost(assertCheckedRead, isCheckedCandidate)
  };
};
