import type { ViewerExtensionMount } from
  "../viewer-extension/descriptor.js";

export {
  loadViewerExtensionDescriptors,
  viewerExtensionAssetTreeSha256,
  type ViewerExtensionMount,
} from "../viewer-extension/descriptor.js";

export function viewerExtensionIndex(
  extensions: readonly ViewerExtensionMount[],
): Readonly<{
  version: "simfile.viewer-extensions.v1";
  extensions: ReadonlyArray<{
    asset_root: string;
    id: string;
    module_url: string;
  }>;
}> {
  return Object.freeze({
    version: "simfile.viewer-extensions.v1",
    extensions: Object.freeze(extensions.map(({ id }) =>
      Object.freeze({
        id,
        module_url: `/_simfile/viewer-extensions/${id}/module.js`,
        asset_root: `/_simfile/viewer-extensions/${id}/assets`,
      }))),
  });
}
