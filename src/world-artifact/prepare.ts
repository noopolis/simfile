import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { prepareDynamicsBuild } from "../dynamics/build.js";
import {
  createDynamicsBuildReceipt,
  type DynamicsBuildReceipt,
} from "../dynamics/buildReceipt.js";
import type { ReadonlyDynamicsJsonObject } from "../dynamics/types.js";
import { parseSimfileSource } from "../schema/parse.js";
import { createWorldServiceArtifact } from "./artifact.js";
import {
  createWorldSidecarAuthoringBinding,
  type WorldSidecarAuthoringBinding,
} from "./authoring.js";
import {
  buildWorldProjectComposer,
  type WorldProjectComposerBuildIdentity,
} from "./composerBuild.js";
import {
  createRunnableWorldSidecarBundle,
  type RunnableWorldSidecarBundle,
} from "./runnableBundle.js";

export interface AuthoredWorldProviderBuild {
  readonly bytes: Uint8Array;
  readonly config: ReadonlyDynamicsJsonObject;
  readonly receipt: DynamicsBuildReceipt;
}

export interface AuthoredWorldComposerSettings {
  readonly defines: Readonly<Record<string, string>>;
  readonly identity: WorldProjectComposerBuildIdentity;
}

export interface PrepareAuthoredWorldSidecarBundleContext {
  readonly binding: WorldSidecarAuthoringBinding;
  readonly provider: AuthoredWorldProviderBuild;
  readonly simfile: ReturnType<typeof parseSimfileSource>["simfile"];
}

export interface PrepareAuthoredWorldSidecarBundleInput {
  readonly binding: WorldSidecarAuthoringBinding;
  create_composer_settings(
    context: PrepareAuthoredWorldSidecarBundleContext,
  ): AuthoredWorldComposerSettings | Promise<AuthoredWorldComposerSettings>;
  /** Project-only authoring assertion; it must not start a service or target. */
  verify_authoring?(
    context: PrepareAuthoredWorldSidecarBundleContext,
  ): void | Promise<void>;
}

export interface PreparedAuthoredWorldSidecarBundle {
  readonly bundle: RunnableWorldSidecarBundle;
  readonly provider: AuthoredWorldProviderBuild;
}

/** Builds the provider, generic entrypoint, selected composer, and sealed bundle. */
export const prepareAuthoredWorldSidecarBundle = async (
  input: PrepareAuthoredWorldSidecarBundleInput,
): Promise<PreparedAuthoredWorldSidecarBundle> => {
  if (input.binding.version !== "simfile.world-sidecar-authoring.v1") {
    throw new TypeError("world sidecar authoring binding version is invalid");
  }
  const { version: _version, ...bindingInput } = input.binding;
  const binding = createWorldSidecarAuthoringBinding(bindingInput);
  const parsed = parseSimfileSource(
    await readFile(binding.simfile_path, "utf8"),
    { path: binding.simfile_path },
  );
  if (parsed.simfile.dynamics === undefined) {
    throw new TypeError("authored world dynamics are missing");
  }
  const prepared = await prepareDynamicsBuild(
    binding.simfile_path,
    parsed.simfile.dynamics.module,
  );
  const receipt = await createDynamicsBuildReceipt(binding.simfile_path, prepared);
  const providerBytes = Uint8Array.from(prepared.artifactBytes);
  if (receipt.payload.artifact_sha256
    !== createHash("sha256").update(providerBytes).digest("hex")) {
    throw new Error("authored world provider receipt drift");
  }
  const context = Object.freeze({
    binding,
    provider: Object.freeze({
      bytes: providerBytes,
      config: parsed.simfile.dynamics.config ?? Object.freeze({}),
      receipt,
    }),
    simfile: parsed.simfile,
  });
  await input.verify_authoring?.(context);
  const [artifact, composerSettings] = await Promise.all([
    createWorldServiceArtifact({
      contract: binding.service_contract,
      dependency_root: binding.dependency_root,
      source_root: binding.source_root,
    }),
    input.create_composer_settings(context),
  ]);
  const composer = await buildWorldProjectComposer({
    defines: composerSettings.defines,
    entry_point: binding.composer.entry_point,
    identity: composerSettings.identity,
    source_root: binding.source_root,
    tool_closure_digest: artifact.manifest.execution_provenance.esbuild.digest,
  });
  const bundle = await createRunnableWorldSidecarBundle({
    artifact,
    composer_bytes: composer.bytes,
    composer_provenance: composer.provenance,
    evidence_root: binding.evidence_root,
    network: binding.network,
    provider_bytes: providerBytes,
    secrets: binding.secrets,
  });
  return Object.freeze({ bundle, provider: context.provider });
};
