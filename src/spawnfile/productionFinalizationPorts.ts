import { z } from "zod";

import type { ComposedExecution } from "../compose/execution.js";
import {
  createComposedWorldEvidenceReceipt,
  createComposedWorldPauseReceipt,
} from "../compose/finalize-world.js";
import { composedPhasePayload } from "../compose/phase.js";
import type { ComposedRunPorts } from "../compose/run.js";
import { parseComposedWorldServiceReceipt } from "../compose/startup-world.js";
import { runSpawnfileArtifactsExport } from "./cli.js";
import { worldInventoryFromTargetExport } from "./evidenceInventory.js";
import {
  resolveSpawnfileLifecycleOutcome,
  runSpawnfileLifecycleLookup,
} from "./lifecycleLookup.js";
import {
  createProductionTargetDriver,
  productionRecord as record,
} from "./productionTarget.js";
import { waitForProductionWorldTerminal } from "./productionTerminal.js";
import { parseSpawnfileExportResult } from "./receipts.js";
import { verifyTargetResourceReceipt } from "./targetReceipts.js";
import { materializeWorldEvidenceArchive } from "./worldEvidenceArchive.js";

type Driver = ReturnType<typeof createProductionTargetDriver>;
const handle = z.string().regex(/^opaque_[a-z0-9]{16,64}$/u);

export const createProductionSupervisionPort = (
  execution: ComposedExecution, driver: Driver,
): ComposedRunPorts["supervision"] => ({
  waitForWorldTerminal: async ({ running, signal }) => {
    const journal = await driver.load();
    const service = parseComposedWorldServiceReceipt(
      composedPhasePayload(journal, "world_started_paused").receipt,
    );
    return waitForProductionWorldTerminal({ journal, provider: execution.provider,
      run_target: driver.runTarget, running, selected_target: driver.selectedTarget,
      service_handle: service.service_handle, signal });
  },
});

export const createProductionWorldFinalizationPort = (
  execution: ComposedExecution, driver: Driver,
): ComposedRunPorts["world_finalization"] => ({
  pauseWorld: async ({ idempotency_key, service, signal, terminal }) => {
    const journal = await driver.load();
    const request = driver.mutation(journal, "stop_world_service", idempotency_key, 7,
      { world_service_handle: service.service_handle });
    const target = verifyTargetResourceReceipt({ operation: "stop_world_service",
      raw: await driver.runTarget("stop_world_service", request, signal), request,
      resulting_revision: 8, run_id: journal.request.run_id });
    await driver.completeTarget("stop_world_service", request, target);
    return createComposedWorldPauseReceipt({ final_tick: terminal.terminal_tick,
      run_id: journal.request.run_id, service_handle: service.service_handle,
      target_operation: target, terminal_receipt_digest: terminal.receipt_digest });
  },
  exportWorldEvidence: async ({ idempotency_key, pause, signal }) => {
    const journal = await driver.load();
    const prepared = record(composedPhasePayload(journal, "prepared").preparation);
    const evidenceHandle = handle.parse(
      record(record(prepared.resources).evidence_volume).result_handle,
    );
    const request = driver.mutation(journal, "export_evidence_volume", idempotency_key, 9,
      { evidence_volume_handle: evidenceHandle });
    const target = verifyTargetResourceReceipt({ operation: "export_evidence_volume",
      raw: await driver.runTarget("export_evidence_volume", request, signal), request,
      resulting_revision: 10, run_id: journal.request.run_id });
    await driver.completeTarget("export_evidence_volume", request, target);
    if (target.export_state !== "exported") {
      throw new TypeError("world evidence export is incomplete");
    }
    const output = execution.provider.world_evidence_export;
    if (output !== undefined) {
      if (target.evidence_index === undefined) {
        throw new TypeError("world evidence export index is absent");
      }
      await materializeWorldEvidenceArchive({ archive_path: output.archive_path,
        destination_directory: output.destination_directory,
        evidence_index: target.evidence_index });
    }
    const service = parseComposedWorldServiceReceipt(
      composedPhasePayload(journal, "world_started_paused").receipt,
    );
    return createComposedWorldEvidenceReceipt({ export_handle: handle.parse(target.result_handle),
      inventory: worldInventoryFromTargetExport(target, evidenceHandle),
      pause_receipt_digest: pause.receipt_digest, run_id: journal.request.run_id,
      source_service_handle: service.service_handle, target_operation: target });
  },
});

export const createProductionOrganizationFinalizationPort = (
  execution: ComposedExecution, driver: Driver,
): ComposedRunPorts["organization_finalization"] => ({
  exportOrganizationEvidence: async ({ deployment_name, lifecycle_invocation_id, signal }) => {
    const provider = execution.provider;
    if (lifecycle_invocation_id !== provider.lifecycle_invocations.export) {
      throw new TypeError("organization export lifecycle invocation is not durable");
    }
    await driver.guard();
    const invoke = () => runSpawnfileArtifactsExport(driver.cli, {
      compiledOutputDirectory: provider.compiled_output_directory,
      deploymentName: deployment_name, destinationDirectory: provider.evidence_destination_directory,
      lifecycleInvocationId: lifecycle_invocation_id, orgPath: provider.organization_path, signal,
    });
    return resolveSpawnfileLifecycleOutcome({ invocation_id: lifecycle_invocation_id, invoke,
      lookup: () => runSpawnfileLifecycleLookup(driver.cli, {
        invocation_id: lifecycle_invocation_id, operation: "artifacts_export", signal,
      }), operation: "artifacts_export", parse: parseSpawnfileExportResult });
  },
});
