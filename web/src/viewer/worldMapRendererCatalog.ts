import type {
  WorldMapRendererDefinition,
  WorldMapRendererFrame,
} from "./WorldMapRendererHost.js";
import { registerActionNarrator } from "./actionNarrators.js";

export {
  narrateAction,
  registerActionNarrator,
  resetActionNarratorsForTests,
  type ActionNarration,
  type ActionNarrationRequest,
  type ActionNarrator,
} from "./actionNarrators.js";

interface ViewerExtensionIndex {
  readonly version: "simfile.viewer-extensions.v1";
  readonly extensions: ReadonlyArray<{
    readonly asset_root?: string;
    readonly id: string;
    readonly module_url: string;
  }>;
}

const renderers: WorldMapRendererDefinition[] = [];
const assetRoots = new Map<string, string>();
const extensionIds = new Set<string>();

const safeId = /^[a-z][a-z0-9-]{0,63}$/u;
const safeMount = /^\/_simfile\/viewer-extensions\/[a-z][a-z0-9-]{0,63}\/(?:assets|module\.js)$/u;

export function registerWorldMapRenderer(
  extensionId: string,
  renderer: WorldMapRendererDefinition,
): void {
  if (!safeId.test(extensionId)
    || !safeId.test(renderer.id)
    || extensionIds.has(extensionId)
    || renderers.some(({ id }) => id === renderer.id)) {
    throw new TypeError("invalid or duplicate viewer renderer registration");
  }
  extensionIds.add(extensionId);
  renderers.push(Object.freeze(renderer));
}

export function viewerExtensionAssetRoot(extensionId: string): string {
  const root = assetRoots.get(extensionId);
  if (root === undefined) {
    throw new Error("viewer extension has no declared asset root");
  }
  return root;
}

globalThis.__SIMFILE_VIEWER_EXTENSION_HOST__ = Object.freeze({
  assetRoot: viewerExtensionAssetRoot,
  registerActionNarrator,
  registerWorldMapRenderer,
});

export async function loadViewerExtensions(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<void> {
  const response = await fetchImpl("/api/viewer-extensions");
  if (!response.ok) {
    throw new Error(`viewer extension index failed with ${response.status}`);
  }
  const index = await response.json() as ViewerExtensionIndex;
  if (index.version !== "simfile.viewer-extensions.v1"
    || !Array.isArray(index.extensions)) {
    throw new TypeError("invalid viewer extension index");
  }
  const modules: string[] = [];
  for (const extension of index.extensions) {
    if (!extension
      || !safeId.test(extension.id)
      || !safeMount.test(extension.module_url)
      || extension.asset_root !== undefined
        && !safeMount.test(extension.asset_root)
      || assetRoots.has(extension.id)) {
      throw new TypeError("invalid viewer extension declaration");
    }
    if (extension.asset_root !== undefined) {
      assetRoots.set(extension.id, extension.asset_root);
    }
    modules.push(extension.module_url);
  }
  for (const moduleUrl of modules) {
    await import(/* @vite-ignore */ moduleUrl);
  }
}

export function selectWorldMapRenderer(
  frame: WorldMapRendererFrame,
): WorldMapRendererDefinition | undefined {
  return renderers.find((renderer) => renderer.matches(frame));
}

export function worldMapPresentationTick(
  frame: WorldMapRendererFrame,
): number | undefined {
  const tick = selectWorldMapRenderer(frame)?.presentationTick?.(frame);
  return tick !== undefined && Number.isFinite(tick) && tick >= 0
    ? tick
    : undefined;
}
