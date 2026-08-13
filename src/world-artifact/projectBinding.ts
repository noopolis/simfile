import type { RunnableWorldSidecarBundle } from "./runnableBundle.js";

export const WORLD_SIDECAR_PROJECT_BINDING_VERSION =
  "simfile.world-sidecar-project-binding.v1" as const;

export interface PrepareWorldSidecarProjectInput {
  readonly evidence_root: string;
  readonly internal_port: number;
  readonly secret_root: string;
}

export interface WorldSidecarProjectBinding {
  readonly version: typeof WORLD_SIDECAR_PROJECT_BINDING_VERSION;
  prepareWorldSidecar(
    input: PrepareWorldSidecarProjectInput,
  ): Promise<RunnableWorldSidecarBundle>;
}

/** Seals the deliberately narrow executable project-to-generic-build seam. */
export const createWorldSidecarProjectBinding = (
  input: Pick<WorldSidecarProjectBinding, "prepareWorldSidecar">,
): WorldSidecarProjectBinding => {
  if (typeof input.prepareWorldSidecar !== "function") {
    throw new TypeError("world sidecar project binding prepare function is invalid");
  }
  return Object.freeze({
    prepareWorldSidecar: input.prepareWorldSidecar,
    version: WORLD_SIDECAR_PROJECT_BINDING_VERSION,
  });
};
