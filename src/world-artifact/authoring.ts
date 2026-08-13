import path from "node:path";

import type { SimfileWorld } from "../schema/model.js";
import {
  compileCapabilityManifests,
  type CapabilityManifestArtifact,
} from "../world/capabilityManifest.js";
import {
  bindWorldGrants,
  resolveWorldGrants,
  type BoundWorldGrant,
  type ResolvedWorldGrant,
  type WorldGrantPrincipalResolver,
} from "../world/grants.js";
import type { WorldSurfaceRegistry } from "../world-surface/index.js";
import type { WorldServiceContract } from "./artifact.js";
import type { RunnableWorldSidecarSecret } from "./runnableBundle.js";

export const WORLD_SIDECAR_AUTHORING_BINDING_VERSION =
  "simfile.world-sidecar-authoring.v1" as const;

export interface WorldSidecarAuthoringBinding {
  readonly version: typeof WORLD_SIDECAR_AUTHORING_BINDING_VERSION;
  readonly source_root: string;
  readonly dependency_root: string;
  readonly simfile_path: string;
  readonly composer: Readonly<{ readonly entry_point: string }>;
  readonly service_contract: WorldServiceContract;
  readonly network: Readonly<{ readonly dns_alias: string; readonly internal_port: number }>;
  readonly evidence_root: string;
  readonly secrets: Readonly<{
    readonly root: string;
    readonly declarations: readonly RunnableWorldSidecarSecret[];
  }>;
}

const portableProjectPath = (value: string, label: string): string => {
  if (!/^[A-Za-z0-9@][A-Za-z0-9@._/-]*$/u.test(value)
    || value.includes("//") || value.split("/").includes("..")
    || path.isAbsolute(value) || !/\.(?:[cm]?[jt]s|tsx)$/u.test(value)) {
    throw new TypeError(`world sidecar authoring ${label} is invalid`);
  }
  return value;
};

const exactAbsolute = (value: string, label: string): string => {
  if (!path.isAbsolute(value) || path.normalize(value) !== value
    || value === path.parse(value).root) {
    throw new TypeError(`world sidecar authoring ${label} is invalid`);
  }
  return value;
};

/** Defines the sole project-selected composer without evaluating authored code. */
export const createWorldSidecarAuthoringBinding = (
  input: Omit<WorldSidecarAuthoringBinding, "version">,
): WorldSidecarAuthoringBinding => {
  const sourceRoot = exactAbsolute(input.source_root, "source root");
  const simfilePath = exactAbsolute(input.simfile_path, "Simfile path");
  const entryPoint = portableProjectPath(input.composer.entry_point, "composer entry point");
  if (simfilePath !== sourceRoot && !simfilePath.startsWith(`${sourceRoot}${path.sep}`)
    || path.join(sourceRoot, entryPoint) === sourceRoot) {
    throw new TypeError("world sidecar authoring project selection escaped source root");
  }
  return Object.freeze({
    ...input,
    composer: Object.freeze({ entry_point: entryPoint }),
    dependency_root: exactAbsolute(input.dependency_root, "dependency root"),
    simfile_path: simfilePath,
    source_root: sourceRoot,
    version: WORLD_SIDECAR_AUTHORING_BINDING_VERSION,
  });
};

export interface CompileAuthoredWorldCapabilitiesInput {
  readonly run_id: string;
  readonly world_instance_id: string;
  readonly world: SimfileWorld;
  readonly surface_registry: WorldSurfaceRegistry;
  readonly principal_resolver: WorldGrantPrincipalResolver;
}

export interface AuthoredWorldCapabilities {
  readonly resolved_grants: readonly ResolvedWorldGrant[];
  readonly bound_grants: readonly BoundWorldGrant[];
  readonly manifests: readonly CapabilityManifestArtifact[];
}

/** Resolves authored grants, binds principals, and compiles their exact manifests. */
export const compileAuthoredWorldCapabilities = (
  input: CompileAuthoredWorldCapabilitiesInput,
): AuthoredWorldCapabilities => {
  const resolvedGrants = resolveWorldGrants(input.world, input.surface_registry);
  const boundGrants = bindWorldGrants(resolvedGrants, input.principal_resolver);
  const manifests = compileCapabilityManifests({
    grants: boundGrants,
    runId: input.run_id,
    surfaceRegistry: input.surface_registry,
    world: { id: input.world.id },
    worldInstanceId: input.world_instance_id,
  });
  return Object.freeze({
    bound_grants: boundGrants,
    manifests,
    resolved_grants: resolvedGrants,
  });
};
