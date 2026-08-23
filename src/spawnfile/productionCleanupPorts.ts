import { createComposedCleanupOperationReceipt } from "../compose/cleanup.js";
import type { ComposedExecution } from "../compose/execution.js";
import { composedPhasePayload } from "../compose/phase.js";
import type { ComposedRunPorts } from "../compose/run.js";
import { parseComposedWorldServiceReceipt } from "../compose/startup-world.js";
import { runSpawnfileDown } from "./cli.js";
import {
  resolveSpawnfileLifecycleOutcome,
  runSpawnfileLifecycleLookup,
} from "./lifecycleLookup.js";
import {
  createProductionTargetDriver,
  productionRecord as record,
} from "./productionTarget.js";
import { parseSpawnfileDownReceipt } from "./receipts.js";
import { parseTargetResourceReceipt, verifyTargetResourceReceipt } from "./targetReceipts.js";

type Driver = ReturnType<typeof createProductionTargetDriver>;

export const createProductionCleanupPort = (
  execution: ComposedExecution,
  driver: Driver,
): ComposedRunPorts["cleanup"] => ({
  performCleanupOperation: async (input) => {
    const journal = await driver.load();
    const resources = record(record(
      composedPhasePayload(journal, "prepared").preparation,
    ).resources);
    const organization = record(
      composedPhasePayload(journal, "organization_started").up_receipt,
    );
    const attachment = parseTargetResourceReceipt(organization.target_attachment);
    const service = parseComposedWorldServiceReceipt(
      composedPhasePayload(journal, "world_started_paused").receipt,
    );
    if (input.operation === "detach_organization") {
      const request = driver.mutation(journal, "detach_organization", input.idempotency_key, 10, {
        data_network_handle: record(resources.data_network).result_handle,
        organization_attachment_handle: attachment.result_handle,
      });
      const receipt = verifyTargetResourceReceipt({ operation: "detach_organization",
        raw: await driver.runTarget("detach_organization", request, input.signal), request,
        resulting_revision: 11, run_id: journal.request.run_id });
      await driver.completeTarget("detach_organization", request, receipt);
    } else if (input.operation === "down_organization") {
      await driver.guard();
      const lifecycleId = execution.provider.lifecycle_invocations.down;
      const down = await resolveSpawnfileLifecycleOutcome({ invocation_id: lifecycleId,
        invoke: () => runSpawnfileDown(driver.cli, {
          compiledOutputDirectory: execution.provider.compiled_output_directory,
          deploymentName: execution.configuration.organization_expectation.deployment_name,
          lifecycleInvocationId: lifecycleId, orgPath: execution.provider.organization_path,
          removeVolumes: true, signal: input.signal,
        }), lookup: () => runSpawnfileLifecycleLookup(driver.cli, {
          invocation_id: lifecycleId, operation: "down", signal: input.signal,
        }), operation: "down", parse: parseSpawnfileDownReceipt });
      if (down.deployment !== execution.configuration.organization_expectation.deployment_name
        || down.errors.length > 0) {
        throw new TypeError("organization down correlation is invalid");
      }
    } else if (input.operation === "revoke_secret_bindings") {
      const request = driver.mutation(journal, "revoke_secret_bindings",
        input.idempotency_key, 11, {
          secret_bindings_handle: record(resources.secret_bindings).result_handle,
        });
      const receipt = verifyTargetResourceReceipt({ operation: "revoke_secret_bindings",
        raw: await driver.runTarget("revoke_secret_bindings", request, input.signal), request,
        resulting_revision: 12, run_id: journal.request.run_id });
      await driver.completeTarget("revoke_secret_bindings", request, receipt);
    } else if (input.operation === "cleanup_target_resources") {
      const request = driver.mutation(journal, "cleanup_run", input.idempotency_key, 12, {
        cleanup_policy: "remove",
        evidence_volume_handle: record(resources.evidence_volume).result_handle,
        organization_attachment_handle: attachment.result_handle,
        secret_bindings_handle: record(resources.secret_bindings).result_handle,
        world_service_handle: service.service_handle,
      });
      const receipt = verifyTargetResourceReceipt({ operation: "cleanup_run",
        raw: await driver.runTarget("cleanup_run", request, input.signal), request,
        resulting_revision: 13, run_id: journal.request.run_id });
      await driver.completeTarget("cleanup_run", request, receipt);
      if (receipt.cleanup_state !== "removed") {
        throw new TypeError("target cleanup is incomplete");
      }
    }
    const released = input.operation === "stop_world" ? [] : [...input.target_handles];
    return createComposedCleanupOperationReceipt({ operation: input.operation,
      ownership_digest: input.ownership_digest, released_handles: released,
      remaining_owned_handles: input.owned_handles.filter((owned) => !released.includes(owned)),
      run_id: journal.request.run_id, state: "completed",
      target_handles: [...input.target_handles] });
  },
});
