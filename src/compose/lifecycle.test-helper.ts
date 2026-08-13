import { createHash } from "node:crypto";
import {
  createWorldSidecarReadiness,
  type WorldSidecarReadiness,
  type WorldSidecarReadinessExpectation,
} from "../world-artifact/readiness.js";
import { appendComposedPhase, createComposedPhaseJournal } from "./journal.js";
import {
  parseComposedRunRequest,
  WORLD_DECISION_CLAIM_CAPABILITY,
  type ComposedRunRequest,
} from "./request.js";
import type { ComposedPhaseJournal } from "./journal.js";
import {
  createComposedWorldResourceReceipt,
  createComposedWorldServiceReceipt,
} from "./startup-world.js";
import { canonicalComposedJson, digestComposedJson } from "./json.js";
import {
  deriveComposedOrganizationDeploymentHandle,
  type ComposedOrganizationExpectation,
} from "./startup-organization.js";
import {
  createComposedRunningReceipt,
  createComposedWorldTerminalReceipt,
  parseComposedWorldTerminalReceipt,
} from "./supervision.js";
import {
  createComposedWorldEvidenceReceipt,
  createComposedWorldPauseReceipt,
} from "./finalize-world.js";
import { COMPOSED_RUN_PHASES } from "./types.js";
export const lifecycleDigest = (value: string): `sha256:${string}` => `sha256:${value.repeat(64).slice(0, 64)}`;
export const lifecycleHandle = (value: string): `opaque_${string}` => `opaque_${value.repeat(16).slice(0, 16)}`;
export const lifecycleRequest = (
  overrides: Partial<ComposedRunRequest> = {},
): ComposedRunRequest => parseComposedRunRequest({
  descriptor_digest: lifecycleDigest("a"),
  mode: "dry-run",
  organization: {
    artifact_digest: lifecycleDigest("b"),
    source_digest: lifecycleDigest("c"),
    world_bindings_digest: lifecycleDigest("d"),
  },
  required_world_capabilities: [],
  run_id: "run-lifecycle",
  source_digest: lifecycleDigest("e"),
  target: { auth_profile: "simfile-live", selector: "gpu-4090" },
  version: "simfile.composed-run-request.v1",
  world: {
    artifact_manifest_digest: lifecycleDigest("f"),
    bundle_digest: lifecycleDigest("1"),
    runtime_abi: "simfile.world-sidecar-runtime.v1",
  },
  ...overrides,
});
const lifecycleSelectedTarget = () => ({
  fingerprint: `sha256:${"1".repeat(32)}`,
  handle: lifecycleHandle("6"),
  version: "spawnfile.target-resource.selected-target.v1" as const,
});
const lifecycleSelectedTargetDigest = (): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(canonicalComposedJson(lifecycleSelectedTarget()))
    .digest("hex")}`;
export const lifecyclePreparation = (request = lifecycleRequest()) => {
  const selected = lifecycleSelectedTarget();
  const resource = (input: Readonly<{
    operation: "create_data_network" | "create_evidence_volume" | "prepare_secret_bindings" | "resolve_world_artifact";
    operationCharacter: string;
    resultCharacter: string;
    revision: number;
  }>) => {
    const body = {
      cleanup_state: "not_requested" as const,
      descriptor_digest: request.descriptor_digest,
      export_state: "not_requested" as const,
      labels: [],
      operation: input.operation,
      operation_handle: lifecycleHandle(input.operationCharacter),
      request_digest: lifecycleDigest(input.operationCharacter),
      result_handle: lifecycleHandle(input.resultCharacter),
      resulting_revision: input.revision,
      run_id: request.run_id,
      selected_target: { fingerprint: selected.fingerprint, handle: selected.handle },
      version: "spawnfile.target-resource.receipt.v1" as const,
    };
    return {
      ...body,
      receipt_digest: digestComposedJson("spawnfile.target-resource.receipt.v1", body),
    };
  };
  const body = {
    auth_profile: request.target.auth_profile,
    descriptor_digest: request.descriptor_digest,
    organization: {
      artifact_digest: request.organization.artifact_digest,
      world_bindings_digest: request.organization.world_bindings_digest,
    },
    request_digest: lifecycleDigest("4"),
    resources: {
      data_network: resource({
        operation: "create_data_network", operationCharacter: "7", resultCharacter: "c", revision: 3,
      }),
      evidence_volume: resource({
        operation: "create_evidence_volume", operationCharacter: "8", resultCharacter: "d", revision: 4,
      }),
      secret_bindings: resource({
        operation: "prepare_secret_bindings", operationCharacter: "f", resultCharacter: "b", revision: 2,
      }),
      world_artifact: resource({
        operation: "resolve_world_artifact", operationCharacter: "e", resultCharacter: "a", revision: 1,
      }),
    },
    run_id: request.run_id,
    selected_target: selected,
    target_selector: request.target.selector,
    version: "spawnfile.composed-preparation.receipt.v1" as const,
    world: {
      artifact_manifest_digest: request.world.artifact_manifest_digest,
      bundle_digest: request.world.bundle_digest,
    },
  };
  return Object.freeze({
    ...body,
    receipt_digest: digestComposedJson("spawnfile.composed-preparation.receipt.v1", body),
  });
};

export const preparedLifecycleJournal = (
  request = lifecycleRequest(),
): ComposedPhaseJournal => appendComposedPhase(
  createComposedPhaseJournal(request, "2026-01-01T00:00:00.000Z"),
  "prepared",
  {
    preparation: lifecyclePreparation(request),
    preparation_receipt_digest: lifecyclePreparation(request).receipt_digest,
    run_id: request.run_id,
  },
  "2026-01-01T00:00:01.000Z",
);

export const lifecycleReadinessExpectation = (
  request = lifecycleRequest(),
  advertiseClaim = true,
): WorldSidecarReadinessExpectation => Object.freeze({
  artifact_digest: lifecycleDigest("8"),
  bundle_digest: request.world.bundle_digest,
  capability_manifest_digests: [lifecycleDigest("7")],
  ...(advertiseClaim ? { capabilities: [{
    identity: WORLD_DECISION_CLAIM_CAPABILITY,
    manifest_digest: lifecycleDigest("7"),
  }] } : {}),
  mechanics_sha256: lifecycleDigest("6"),
  normalized_checkpoint_sha256: lifecycleDigest("5"),
  run_id: request.run_id,
  world_instance_id: `${request.run_id}-world`,
});

export const lifecycleReadiness = (
  request = lifecycleRequest(),
  advertiseClaim = true,
): WorldSidecarReadiness => createWorldSidecarReadiness({
  ...lifecycleReadinessExpectation(request, advertiseClaim),
  clock: { next_tick: 0, state: "paused" },
  decisions: { count: 0, phase: "open" },
  runtime_abi: "simfile.world-sidecar-runtime.v1",
  status: "ready",
  version: "simfile.world-sidecar-readiness.v1",
});

export const worldReadyLifecycleJournal = (
  request = lifecycleRequest(),
  advertiseClaim = true,
): ComposedPhaseJournal => {
  const preparation = lifecyclePreparation(request);
  const resource = createComposedWorldResourceReceipt({
    artifact_digest: request.world.artifact_manifest_digest,
    bundle_digest: request.world.bundle_digest,
    preparation_receipt_digest: preparation.receipt_digest,
    resource_handle: lifecycleHandle("2"),
    run_id: request.run_id,
  });
  const service = createComposedWorldServiceReceipt({
    resource_handle: resource.resource_handle,
    run_id: request.run_id,
    service_handle: lifecycleHandle("3"),
  });
  const readiness = lifecycleReadiness(request, advertiseClaim);
  let journal = preparedLifecycleJournal(request);
  journal = appendComposedPhase(journal, "world_created", {
    receipt: resource, run_id: request.run_id,
  }, "2026-01-01T00:00:02.000Z");
  journal = appendComposedPhase(journal, "world_started_paused", {
    receipt: service, run_id: request.run_id,
  }, "2026-01-01T00:00:03.000Z");
  return appendComposedPhase(journal, "world_ready", {
    readiness,
    readiness_digest: digestComposedJson("simfile.composed-world-readiness.v1", readiness),
    run_id: request.run_id,
  }, "2026-01-01T00:00:04.000Z");
};

export const lifecycleOrganizationExpectation = (): ComposedOrganizationExpectation => ({
  deployment_name: "organization-unit", unit_id: "organization-unit-container",
  member_engines: { "member:alpha": "engine-one", "member:beta": "engine-two" },
  moltnet_release: {
    architecture: "amd64",
    asset_sha256: lifecycleDigest("a"),
    release_version: "v0.1.14-1-gaaaaaaa",
    source_revision: "a".repeat(40),
  },
  selected_target_receipt_digest: lifecycleSelectedTargetDigest(),
  world_binding_digest: lifecycleDigest("d"),
});

export const lifecycleOrganizationUpReceipt = (runId: string, ready: boolean) => {
  const handoff = {
    binding_digest: lifecycleDigest("d"),
    lifecycle_receipts: {
      down: "spawnfile.down-receipt.v1" as const,
      export: "spawnfile.export-index.v1" as const,
      up: "spawnfile.up-receipt.v1" as const,
    },
    network_attachment_handle: lifecycleHandle("4"),
    run_id: runId,
    selected_target_receipt_digest: lifecycleSelectedTargetDigest(),
  };
  const attachmentBody = {
    cleanup_state: "not_requested" as const,
    descriptor_digest: lifecycleDigest("a"),
    export_state: "not_requested" as const,
    labels: [],
    operation: "attach_organization" as const,
    operation_handle: lifecycleHandle("9"),
    request_digest: lifecycleDigest("9"),
    result_handle: lifecycleHandle("6"),
    resulting_revision: 7,
    run_id: runId,
    selected_target: {
      fingerprint: lifecycleSelectedTarget().fingerprint,
      handle: lifecycleSelectedTarget().handle,
    },
    version: "spawnfile.target-resource.receipt.v1" as const,
  };
  return {
    compiled_schedule: [],
    deployment: { container_ids: ["organization-container"], name: "organization-unit" },
    engines: [
      { agent: "member:alpha", engine: "engine-one" },
      { agent: "member:beta", engine: "engine-two" },
    ],
    fingerprint: "sf1:0123456789ab",
    moltnet_release: {
      architecture: "amd64",
      asset: "moltnet_linux_amd64.tar.gz",
      asset_sha256: lifecycleDigest("a"),
      capabilities: ["pi-bridge"],
      release_version: "v0.1.14-1-gaaaaaaa",
      source_revision: "a".repeat(40),
      version: "spawnfile.moltnet-release-identity.v1",
    },
    organization_handoff: {
      ...handoff,
      deployment_handle: deriveComposedOrganizationDeploymentHandle(handoff),
      version: "spawnfile.organization-handoff.v1",
    },
    organization_handoff_handle: lifecycleHandle("5"),
    target_attachment: { ...attachmentBody,
      receipt_digest: digestComposedJson(
        "spawnfile.target-resource.receipt.v1", attachmentBody,
      ) },
    ...(ready ? {
      organization_ready: {
        code: "organization_ready",
        compile_fingerprint: "sf1:0123456789ab",
        run_id: runId,
        state: "ready",
        unit_id: "organization-unit-container",
        version: "spawnfile.organization-ready.v1",
        world_binding_digest: lifecycleDigest("d"),
      },
    } : {}),
    readiness: { moltnet_base_url: "http://organization.internal:19971", state: "running" },
    run_id: runId,
    version: "spawnfile.up-receipt.v1",
  };
};

export const organizationReadyLifecycleJournal = (
  request = lifecycleRequest(),
  advertiseClaim = true,
): ComposedPhaseJournal => {
  const started = lifecycleOrganizationUpReceipt(request.run_id, false);
  const ready = lifecycleOrganizationUpReceipt(request.run_id, true);
  let journal = worldReadyLifecycleJournal(request, advertiseClaim);
  journal = appendComposedPhase(journal, "organization_started", {
    run_id: request.run_id,
    up_receipt: started,
    up_receipt_digest: digestComposedJson("spawnfile.up-receipt.v1", started),
  }, "2026-01-01T00:00:05.000Z");
  return appendComposedPhase(journal, "organization_ready", {
    moltnet_release: ready.moltnet_release,
    organization_handoff: ready.organization_handoff,
    readiness: ready.organization_ready,
    receipt_digest: digestComposedJson("spawnfile.up-receipt.v1", ready),
    run_id: request.run_id,
  }, "2026-01-01T00:00:06.000Z");
};

export const tickOneLifecycleJournal = (
  request = lifecycleRequest(),
): ComposedPhaseJournal => {
  let journal = organizationReadyLifecycleJournal(request);
  journal = appendComposedPhase(journal, "topology_verified", {
    receipt_digest: lifecycleDigest("7"), run_id: request.run_id,
  }, "2026-01-01T00:00:07.000Z");
  journal = appendComposedPhase(journal, "activated", {
    receipt_digest: lifecycleDigest("8"), run_id: request.run_id,
  }, "2026-01-01T00:00:08.000Z");
  return appendComposedPhase(journal, "tick_1", {
    receipt_digest: lifecycleDigest("9"), run_id: request.run_id,
  }, "2026-01-01T00:00:09.000Z");
};

export const terminalLifecycleJournal = (
  request = lifecycleRequest(),
  terminalTick = 4,
): ComposedPhaseJournal => {
  let journal = tickOneLifecycleJournal(request);
  const running = createComposedRunningReceipt({
    activation_receipt_digest: lifecycleDigest("8"),
    first_tick_receipt_digest: lifecycleDigest("9"),
    run_id: request.run_id,
  });
  journal = appendComposedPhase(journal, "running", {
    receipt: running, receipt_digest: running.receipt_digest, run_id: request.run_id,
  }, "2026-01-01T00:00:10.000Z");
  const terminal = createComposedWorldTerminalReceipt({
    outcome_digest: lifecycleDigest("0"),
    reason: "completed",
    run_id: request.run_id,
    running_receipt_digest: running.receipt_digest,
    terminal_tick: terminalTick,
  });
  return appendComposedPhase(journal, "terminal", {
    receipt: terminal, receipt_digest: terminal.receipt_digest, run_id: request.run_id,
  }, "2026-01-01T00:00:11.000Z");
};

export const worldEvidenceLifecycleJournal = (
  request = lifecycleRequest(),
): ComposedPhaseJournal => {
  let journal = terminalLifecycleJournal(request);
  const terminal = parseComposedWorldTerminalReceipt(
    journal.entries[11]!.payload.receipt,
  );
  const pause = createComposedWorldPauseReceipt({
    final_tick: terminal.terminal_tick,
    run_id: request.run_id,
    service_handle: lifecycleHandle("3"),
    terminal_receipt_digest: terminal.receipt_digest,
  });
  journal = appendComposedPhase(journal, "world_paused", {
    receipt: pause, receipt_digest: pause.receipt_digest, run_id: request.run_id,
  }, "2026-01-01T00:00:12.000Z");
  const evidence = createComposedWorldEvidenceReceipt({
    export_handle: lifecycleHandle("7"),
    inventory: [
      { authority: "actions", bytes: 1, path: "actions/log.jsonl", sha256: lifecycleDigest("a") },
      { authority: "checkpoints", bytes: 2, path: "checkpoints/final.json", sha256: lifecycleDigest("b") },
      { authority: "projections", bytes: 3, path: "projections/world.json", sha256: lifecycleDigest("c") },
    ],
    pause_receipt_digest: pause.receipt_digest,
    run_id: request.run_id,
    source_service_handle: pause.service_handle,
  });
  return appendComposedPhase(journal, "world_evidence_exported", {
    evidence, receipt_digest: evidence.receipt_digest, run_id: request.run_id,
  }, "2026-01-01T00:00:13.000Z");
};

let lifecycleTimestampSequence = COMPOSED_RUN_PHASES.length;

export const lifecyclePhaseContext = (input: Readonly<{
  afterPhase?: (phase: Parameters<NonNullable<import("./types.js").ComposedRunFaultInjector["afterPhase"]>>[0]) => void;
  persisted?: ComposedPhaseJournal[];
}> = {}) => {
  const persisted = input.persisted ?? [];
  return Object.freeze({
    context: {
      fault_injector: input.afterPhase ? { afterPhase: input.afterPhase } : undefined,
      now: () => new Date(Date.UTC(
        2026, 0, 1, 0, 0, lifecycleTimestampSequence++,
      )).toISOString(),
      persist: (journal: ComposedPhaseJournal) => { persisted.push(journal); },
    },
    persisted,
  });
};
