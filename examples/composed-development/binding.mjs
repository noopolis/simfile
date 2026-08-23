import { realpath } from "node:fs/promises";

import { createComposedProjectBinding } from "simfile/compose";
import {
  createWorldSidecarAuthoringBinding,
  prepareAuthoredWorldSidecarBundle,
  WORLD_DECISION_CLAIM_CAPABILITY,
  worldReadinessHashes,
  worldReadinessIdentity,
} from "simfile/world-artifact";

import {
  evidenceArtifacts,
  exampleSimfile,
  exampleSpawnfile,
  loadKernel,
  packageRoot,
  replayAdapter,
  serviceContract,
  terminalTick,
  worldInstanceId,
} from "./binding-world.mjs";

export const composedProjectBinding = createComposedProjectBinding({
  async prepareComposedProject(input) {
    const [actualSimfile, actualSpawnfile, expectedSimfile, expectedSpawnfile] =
      await Promise.all([
        realpath(input.simfile_path), realpath(input.spawnfile_path),
        realpath(exampleSimfile), realpath(exampleSpawnfile),
      ]);
    if (actualSimfile !== expectedSimfile || actualSpawnfile !== expectedSpawnfile) {
      throw new TypeError("composed development project paths are invalid");
    }
    let kernel;
    const authored = await prepareAuthoredWorldSidecarBundle({
      binding: createWorldSidecarAuthoringBinding({
        composer: {
          entry_point: "examples/composed-development/world/composer.mjs",
        },
        dependency_root: packageRoot,
        evidence_root: input.evidence_root,
        network: { dns_alias: "world", internal_port: input.internal_port },
        secrets: {
          declarations: [{
            name: "world_token",
            principal: "agent:smoke",
            scope: "world",
          }],
          root: input.secret_root,
        },
        service_contract: serviceContract,
        simfile_path: exampleSimfile,
        source_root: packageRoot,
      }),
      async create_composer_settings(context) {
        kernel = await loadKernel(input.run_id, input.seed);
        if (kernel.session.buildReceipt.receiptSha256
          !== context.provider.receipt.receiptSha256) {
          throw new Error("composed development provider receipt drift");
        }
        return {
          defines: {
            __BUILD_RECEIPT__: JSON.stringify(context.provider.receipt),
            __EVIDENCE_ROOT__: JSON.stringify(input.evidence_root),
            __PROVIDER_CONFIG__: JSON.stringify(context.provider.config),
            __PROVIDER_PROVENANCE__: JSON.stringify(kernel.session.provenance),
            __RUN_ID__: JSON.stringify(input.run_id),
            __SEED__: JSON.stringify(input.seed),
            __SIM_SECONDS_PER_TICK__: JSON.stringify(
              kernel.checkpoint.dynamics.sim_seconds_per_tick,
            ),
            __TERMINAL_TICK__: JSON.stringify(terminalTick),
            __WORLD__: JSON.stringify(kernel.parsed.simfile.world),
            __WORLD_INSTANCE_ID__: JSON.stringify(worldInstanceId),
          },
          identity: {
            build_receipt: context.provider.receipt,
            configuration: context.provider.config,
            provider_provenance: kernel.session.provenance,
          },
        };
      },
    });
    if (kernel === undefined || kernel.runtimeInput.capabilityManifests.length !== 1) {
      throw new Error("composed development capability preparation is incomplete");
    }
    const identity = worldReadinessIdentity(kernel.checkpoint);
    const hashes = worldReadinessHashes(kernel.checkpoint);
    const manifestDigest = identity.capability_manifest_digests[0];
    return {
      base_image_config_digest: input.base_image_config_digest,
      bundle: authored.bundle,
      credentials: [{
        bytes: 32,
        env: "SIMFILE_WORLD_TOKEN",
        kind: "generated-token",
        name: "world_token",
      }],
      evidence_artifacts: evidenceArtifacts,
      platform: input.platform,
      readiness_expectation: {
        artifact_digest: authored.bundle.manifest.artifact.service_digest,
        bundle_digest: authored.bundle.manifest.digest,
        capabilities: [{
          identity: WORLD_DECISION_CLAIM_CAPABILITY,
          manifest_digest: manifestDigest,
        }],
        capability_manifest_digests: identity.capability_manifest_digests,
        mechanics_sha256: hashes.mechanics,
        normalized_checkpoint_sha256: hashes.normalized_checkpoint,
        run_id: identity.run_id,
        world_instance_id: identity.world_instance_id,
      },
      replay_adapter: replayAdapter(input.run_id, input.seed),
      secret_bindings: [{
        credential_name: "world_token",
        name: "world_token",
        scope: "world",
      }],
      terminal_tick: terminalTick,
      world_members: [{
        capability_manifest: kernel.runtimeInput.capabilityManifests[0].manifest,
        id: "smoke",
        principal_id: "agent:smoke",
        token_credential_name: "world_token",
      }],
    };
  },
});
