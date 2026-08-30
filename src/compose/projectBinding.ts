import { z } from "zod";

import type { ComposedReplayAdapter } from "./replay.js";
import type { ComposedArtifactRole } from "./runRecord.js";
import {
  parseComposedViewerBinding,
  type ComposedViewerBinding,
} from "./viewerBinding.js";
import {
  parseRunnableWorldSidecarManifest,
  type RunnableWorldSidecarBundle,
} from "../world-artifact/runnableBundle.js";
import {
  verifyWorldSidecarReadiness,
  type WorldSidecarReadinessExpectation,
} from "../world-artifact/readiness.js";

export const COMPOSED_PROJECT_BINDING_VERSION =
  "simfile.composed-project-binding.v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const environment = z.string().regex(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u);
const relativePath = z.string().max(4_096).refine((value) =>
  value.length > 0 && !value.startsWith("/") && !value.includes("\\")
  && value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."));
const credential = z.discriminatedUnion("kind", [
  z.object({ bytes: z.number().int().min(16).max(128), env: environment,
    kind: z.literal("generated-token"), name: identifier }).strict(),
  z.object({ content: z.unknown(), env: environment,
    kind: z.literal("derived-config"), name: identifier }).strict(),
]);
const member = z.object({
  capability_manifest: z.unknown(),
  id: identifier,
  principal_id: z.string().min(1).max(256),
  token_credential_name: identifier,
}).strict();
const binding = z.object({
  credential_name: identifier,
  name: identifier,
  scope: identifier,
}).strict();
const evidence = z.object({
  path: relativePath,
  role: z.enum([
    "accepted-action", "action-result", "authority-export", "identity",
    "presentation", "probe", "provenance", "terminal", "world-checkpoint",
    "world-frame",
  ]),
  source: relativePath,
}).strict();

export interface PrepareComposedProjectInput {
  readonly base_image_config_digest: string;
  readonly evidence_root: string;
  readonly internal_port: number;
  readonly organization_container_name: string;
  readonly platform: Readonly<{ architecture: "amd64" | "arm64"; os: "linux" }>;
  readonly run_id: string;
  readonly seed: string;
  readonly secret_root: string;
  readonly simfile_path: string;
  readonly spawnfile_path: string;
}

export interface ComposedProjectPreparation {
  readonly base_image_config_digest: string;
  readonly bundle: RunnableWorldSidecarBundle;
  readonly credentials: readonly z.infer<typeof credential>[];
  readonly evidence_artifacts: readonly Readonly<{
    path: string;
    role: ComposedArtifactRole;
    source: string;
  }>[];
  readonly platform: Readonly<{ architecture: "amd64" | "arm64"; os: "linux" }>;
  readonly readiness_expectation: WorldSidecarReadinessExpectation;
  readonly replay_adapter: ComposedReplayAdapter;
  readonly secret_bindings: readonly z.infer<typeof binding>[];
  readonly terminal_tick: number;
  readonly viewer?: ComposedViewerBinding;
  readonly world_members: readonly z.infer<typeof member>[];
}

/**
 * Trusted project-code contract: binding module evaluation and
 * prepareComposedProject execution must not cause lifecycle or Simfile
 * support-state effects. Preparation may only author and return its declared
 * project artifact inputs. Simfile does not sandbox arbitrary project JavaScript.
 */
export interface ComposedProjectBinding {
  readonly version: typeof COMPOSED_PROJECT_BINDING_VERSION;
  prepareComposedProject(
    input: PrepareComposedProjectInput,
  ): Promise<ComposedProjectPreparation>;
}

const validateComposedProjectPreparation = (
  value: ComposedProjectPreparation,
  input: PrepareComposedProjectInput,
): ComposedProjectPreparation => {
  const manifest = parseRunnableWorldSidecarManifest(value.bundle.manifest);
  if (manifest.digest !== value.readiness_expectation.bundle_digest) {
    throw new TypeError("composed project bundle readiness is invalid");
  }
  verifyWorldSidecarReadiness({
    ...value.readiness_expectation,
    clock: { next_tick: 0, state: "paused" },
    decisions: { count: 0, phase: "open" },
    runtime_abi: manifest.runtime_abi,
    status: "ready",
    version: "simfile.world-sidecar-readiness.v1",
  }, value.readiness_expectation);
  const credentials = z.array(credential).min(1).max(64).parse(value.credentials);
  const members = z.array(member).min(1).max(64).parse(value.world_members);
  const bindings = z.array(binding).min(1).max(64).parse(value.secret_bindings);
  const artifacts = z.array(evidence).min(1).max(64).parse(value.evidence_artifacts);
  const viewer = parseComposedViewerBinding(value.viewer, artifacts);
  const names = new Set(credentials.map(({ name }) => name));
  if (new Set(credentials.map(({ env }) => env)).size !== credentials.length
    || names.size !== credentials.length
    || members.some(({ token_credential_name: name }) => !names.has(name))
    || bindings.some(({ credential_name: name }) => !names.has(name))
    || new Set(artifacts.map(({ path: artifactPath }) => artifactPath)).size !== artifacts.length
    || typeof value.replay_adapter?.restore !== "function"
    || typeof value.replay_adapter.inject !== "function"
    || typeof value.replay_adapter.finish !== "function"
    || value.readiness_expectation.run_id !== input.run_id
    || input.seed.length < 1 || input.seed.length > 4_096
    || value.base_image_config_digest !== input.base_image_config_digest
    || value.platform.architecture !== input.platform.architecture
    || value.platform.os !== input.platform.os
    || !Number.isSafeInteger(value.terminal_tick) || value.terminal_tick < 1
    || !digest.safeParse(value.base_image_config_digest).success) {
    throw new TypeError("composed project preparation is invalid");
  }
  return Object.freeze({ ...value, credentials: Object.freeze(credentials),
    evidence_artifacts: Object.freeze(artifacts), secret_bindings: Object.freeze(bindings),
    ...(viewer === undefined ? {} : { viewer }),
    world_members: Object.freeze(members) });
};

/** Creates the host-only fixture declaration seam; it owns no lifecycle operation. */
export const createComposedProjectBinding = (
  input: Pick<ComposedProjectBinding, "prepareComposedProject">,
): ComposedProjectBinding => {
  if (typeof input.prepareComposedProject !== "function") {
    throw new TypeError("composed project binding prepare function is invalid");
  }
  return Object.freeze({
    prepareComposedProject: async (request: PrepareComposedProjectInput) => validateComposedProjectPreparation(
      await input.prepareComposedProject(request), request,
    ),
    version: COMPOSED_PROJECT_BINDING_VERSION,
  });
};
