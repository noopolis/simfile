import { z } from "zod";

import type { ComposedArtifactRole } from "./runRecord.js";

export const COMPOSED_VIEWER_BINDING_VERSION =
  "simfile.composed-viewer-binding.v1" as const;

const extensionId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const artifactId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const relativePath = z.string().max(4_096).refine((value) =>
  value.length > 0 && !value.startsWith("/") && !value.includes("\\")
  && value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."));
const publicPath = z.string().max(255).regex(
  /^\/tmp\/spawnfile-public\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u,
).refine((value) => !value.includes("//")
  && value.slice("/tmp/spawnfile-public/".length).split("/")
    .every((part) => part.length > 0 && part !== "." && part !== ".."));
const extension = z.object({
  id: extensionId,
  recorded_artifact: relativePath,
}).strict();
const liveTrace = z.object({
  artifact: z.object({
    id: artifactId,
    max_bytes: z.number().int().min(1).max(131_072),
    media_type: z.literal("application/json"),
    path: publicPath,
  }).strict(),
  extension_id: extensionId,
}).strict();
const viewerBinding = z.object({
  extensions: z.array(extension).min(1).max(32),
  live_trace: liveTrace.optional(),
  version: z.literal(COMPOSED_VIEWER_BINDING_VERSION),
}).strict();

type ParsedViewerBinding = z.infer<typeof viewerBinding>;
export interface ComposedViewerBinding {
  readonly extensions: readonly Readonly<ParsedViewerBinding["extensions"][number]>[];
  readonly live_trace?: Readonly<{
    artifact: Readonly<NonNullable<ParsedViewerBinding["live_trace"]>["artifact"]>;
    extension_id: string;
  }>;
  readonly version: typeof COMPOSED_VIEWER_BINDING_VERSION;
}

/** Validates the optional host-only viewer projection declaration. */
export const parseComposedViewerBinding = (
  raw: unknown,
  artifacts: readonly Readonly<{ path: string; role: ComposedArtifactRole }>[],
): ComposedViewerBinding | undefined => {
  if (raw === undefined) return undefined;
  const parsed = viewerBinding.parse(raw);
  const ids = new Set(parsed.extensions.map(({ id }) => id));
  const paths = new Set<string>();
  if (ids.size !== parsed.extensions.length
    || parsed.extensions.some(({ recorded_artifact: artifactPath }) => {
      if (paths.has(artifactPath)) return true;
      paths.add(artifactPath);
      return !artifacts.some(({ path, role }) =>
        path === artifactPath && role === "presentation");
    })
    || (parsed.live_trace !== undefined
      && !ids.has(parsed.live_trace.extension_id))) {
    throw new TypeError("composed viewer binding is invalid");
  }
  return Object.freeze({
    ...parsed,
    extensions: Object.freeze(parsed.extensions.map((entry) => Object.freeze(entry))),
    ...(parsed.live_trace === undefined ? {} : {
      live_trace: Object.freeze({
        ...parsed.live_trace,
        artifact: Object.freeze(parsed.live_trace.artifact),
      }),
    }),
  });
};
