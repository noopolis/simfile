import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  build,
  version as esbuildVersion,
  type Loader,
  type Metafile,
  type Plugin,
} from "esbuild";

import { canonicalJson, compareUtf16 } from "../dynamics/buildIdentity.js";
import {
  parseRunnableWorldComposerProvenance,
  type RunnableWorldComposerProvenance,
} from "./runnableBundle.js";

export interface WorldProjectComposerBuildIdentity {
  readonly build_receipt: unknown;
  readonly configuration: unknown;
  readonly provider_provenance: unknown;
}

export interface BuildWorldProjectComposerInput {
  readonly source_root: string;
  readonly entry_point: string;
  readonly defines: Readonly<Record<string, string>>;
  readonly identity: WorldProjectComposerBuildIdentity;
  readonly tool_closure_digest: string;
}

export interface WorldProjectComposerBuild {
  readonly bytes: Uint8Array;
  readonly provenance: RunnableWorldComposerProvenance;
}

const sha = (value: Uint8Array): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const identityDigest = (value: unknown): string =>
  sha(new TextEncoder().encode(canonicalJson(value)));
const loader = (file: string): Loader => ({
  ".cjs": "js", ".js": "js", ".json": "json", ".mjs": "js",
  ".ts": "ts", ".tsx": "tsx",
}[path.extname(file)] as Loader | undefined) ?? "js";

const composerProvenance = (
  input: BuildWorldProjectComposerInput,
  metafile: Metafile,
  snapshots: ReadonlyMap<string, Uint8Array>,
): RunnableWorldComposerProvenance => {
  const expected = Object.keys(metafile.inputs)
    .filter((item) => !item.startsWith("<"))
    .map((item) => path.resolve(input.source_root, item));
  if (expected.length !== snapshots.size
    || expected.some((absolute) => !snapshots.has(absolute))) {
    throw new Error("world composer snapshot/metafile mismatch");
  }
  const sourceGraph = expected.map((absolute) => {
    const bytes = snapshots.get(absolute)!;
    return Object.freeze({
      bytes: bytes.byteLength,
      path: path.relative(input.source_root, absolute).split(path.sep).join("/"),
      sha256: sha(bytes),
    });
  }).sort((left, right) => compareUtf16(left.path, right.path));
  const config = Object.freeze({
    absWorkingDir: "source_root",
    bundle: true,
    charset: "utf8",
    defines: Object.freeze({
      build_receipt_sha256: identityDigest(input.identity.build_receipt),
      config_sha256: identityDigest(input.identity.configuration),
      provenance_sha256: identityDigest(input.identity.provider_provenance),
    }),
    entryPoint: input.entry_point,
    external: Object.freeze(["./entrypoint.mjs", "./provider.mjs"]),
    format: "esm",
    legalComments: "none",
    metafile: true,
    platform: "node",
    sourceSnapshot: true,
    sourcemap: false,
    target: "node22",
    write: false,
  });
  const unsigned = Object.freeze({
    config,
    source_graph: Object.freeze(sourceGraph),
    tool: Object.freeze({
      closure_digest: input.tool_closure_digest,
      name: "esbuild" as const,
      version: esbuildVersion,
    }),
    version: "simfile.world-composer-build.v1" as const,
  });
  return parseRunnableWorldComposerProvenance({
    ...unsigned,
    digest: `sha256:${createHash("sha256")
      .update(canonicalJson({ domain: "simfile.world-composer-build.v1", value: unsigned }))
      .digest("hex")}`,
  });
};

/** Snapshots and bundles the selected project composer without executing it. */
export const buildWorldProjectComposer = async (
  input: BuildWorldProjectComposerInput,
): Promise<WorldProjectComposerBuild> => {
  const root = path.resolve(input.source_root);
  const composerPath = path.resolve(root, input.entry_point);
  if (root !== input.source_root || composerPath !== path.join(root, input.entry_point)
    || composerPath === root || !composerPath.startsWith(`${root}${path.sep}`)
    || !/^sha256:[a-f0-9]{64}$/u.test(input.tool_closure_digest)) {
    throw new TypeError("world composer build identity is invalid");
  }
  const snapshots = new Map<string, Uint8Array>();
  const snapshotPlugin: Plugin = {
    name: "simfile-world-composer-source-snapshot",
    setup(pluginBuild) {
      pluginBuild.onLoad({ filter: /.*/, namespace: "file" }, async ({ path: file }) => {
        const absolute = path.resolve(file);
        if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
          throw new Error("world composer source escaped source root");
        }
        const contents = new Uint8Array(await readFile(absolute));
        if (snapshots.has(absolute)) throw new Error("world composer source loaded twice");
        snapshots.set(absolute, contents);
        return { contents, loader: loader(absolute) };
      });
    },
  };
  const result = await build({
    absWorkingDir: root,
    bundle: true,
    charset: "utf8",
    define: { ...input.defines },
    entryPoints: [composerPath],
    external: ["./entrypoint.mjs", "./provider.mjs"],
    format: "esm",
    legalComments: "none",
    metafile: true,
    platform: "node",
    plugins: [snapshotPlugin],
    sourcemap: false,
    target: "node22",
    write: false,
  });
  const bytes = result.outputFiles?.[0]?.contents;
  if (!bytes || result.outputFiles?.length !== 1 || bytes.byteLength < 1 || !result.metafile) {
    throw new Error("world composer build failed");
  }
  return Object.freeze({
    bytes: Uint8Array.from(bytes),
    provenance: composerProvenance(input, result.metafile, snapshots),
  });
};
