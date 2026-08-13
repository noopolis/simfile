import type { ComposedProjectPreparation } from "../compose/projectBinding.js";
import type {
  LoadedProjectViewerExtensions,
} from "../viewer-extension/projectDeclaration.js";

export interface LinkedComposedViewerManifestFields {
  readonly viewer_extension_data: Readonly<Record<string, string>>;
  readonly viewer_projection?: string;
}

/**
 * Corroborates fixture-declared presentation data against the trusted local
 * extension ids before any run directory is reserved.
 */
export const linkedComposedViewerManifestFields = (
  preparation: ComposedProjectPreparation,
  project: LoadedProjectViewerExtensions,
): LinkedComposedViewerManifestFields | undefined => {
  const viewer = preparation.viewer;
  if (viewer === undefined) return undefined;
  const trustedIds = new Set(project.declaration.extensions.map(({ id }) => id));
  if (viewer.extensions.some(({ id }) => !trustedIds.has(id))) {
    throw new TypeError("composed viewer binding references an undeclared extension");
  }
  const data = Object.freeze(Object.fromEntries(viewer.extensions.map(({ id,
    recorded_artifact }) => [id, recorded_artifact])));
  const projection = viewer.live_trace === undefined
    ? undefined
    : data[viewer.live_trace.extension_id];
  return Object.freeze({
    viewer_extension_data: data,
    ...(projection === undefined ? {} : { viewer_projection: projection }),
  });
};
