import { z } from "zod";

import type { ComposedExecution } from "../compose/execution.js";
import { composedPhasePayload } from "../compose/phase.js";
import type { ComposedRunPorts } from "../compose/run.js";
import { runSpawnfileUp } from "./cli.js";
import { parseSpawnfileUpReceipt } from "./receipts.js";
import {
  resolveSpawnfileLifecycleOutcome,
  runSpawnfileLifecycleLookup,
} from "./lifecycleLookup.js";
import { resolveSpawnfileOrganizationAuthentication } from
  "./organizationAuthentication.js";
import {
  createProductionTargetDriver,
  productionRecord as record,
} from "./productionTarget.js";
import { verifyTargetResourceReceipt } from "./targetReceipts.js";

const handle = z.string().regex(/^opaque_[a-z0-9]{16,64}$/u);

type ProductionTargetDriver = ReturnType<typeof createProductionTargetDriver>;

export const createProductionOrganizationPorts = (
  execution: ComposedExecution,
  driver: ProductionTargetDriver,
): ComposedRunPorts["organization"] => {
  const provider = execution.provider;
  const { cli, completeTarget, guard, load, mutation, runTarget } = driver;
  const complete = completeTarget ?? (async (_command: string, _request: Readonly<Record<string, unknown>>,
    _receipt: Readonly<Record<string, unknown>>): Promise<void> => undefined);
  return {
    startOrganization: async ({ idempotency_key, signal }) => {
      const journal = await load();
      const preparation = record(composedPhasePayload(journal, "prepared").preparation);
      const dataNetwork = record(record(preparation.resources).data_network);
      const networkAttachmentHandle = handle.parse(dataNetwork.result_handle);
      const authentication = resolveSpawnfileOrganizationAuthentication({
        configured_auth_profile: journal.request.target.auth_profile,
        member_engines: execution.configuration.organization_expectation.member_engines,
      });
      await guard();
      const upInput = {
        ...(authentication.kind === "model"
          ? { authProfile: authentication.spawnfile_up_auth_profile } : {}),
        compiledOutputDirectory: provider.compiled_output_directory,
        containerName: provider.organization_container_name,
        deploymentName: execution.configuration.organization_expectation.deployment_name,
        descriptorDigest: journal.request.descriptor_digest,
        dockerContext: journal.request.target.selector,
        envFile: provider.organization_handoff.env_file,
        imageTag: provider.organization_image_tag,
        lifecycleInvocationId: provider.lifecycle_invocations.up,
        networkAttachmentHandle,
        orgPath: provider.organization_path,
        organizationHandoffRunId: journal.request.run_id,
        selectedTargetReceiptDigest:
          execution.configuration.organization_expectation.selected_target_receipt_digest,
        selectedTargetReceiptFile:
          provider.organization_handoff.selected_target_receipt_file,
        signal,
        worldBindingsFile: provider.organization_handoff.world_bindings_file,
      } as const;
      const lifecycleId = provider.lifecycle_invocations.up;
      const up = await resolveSpawnfileLifecycleOutcome({
        invocation_id: lifecycleId,
        invoke: () => runSpawnfileUp(cli, upInput),
        lookup: () => runSpawnfileLifecycleLookup(cli, {
          invocation_id: lifecycleId, operation: "up", signal,
        }),
        operation: "up",
        parse: parseSpawnfileUpReceipt,
      });
      const handoff = handle.parse(record(up).organization_handoff_handle);
      const request = mutation(journal, "attach_organization", idempotency_key, 6, {
        data_network_handle: dataNetwork.result_handle,
        organization_handoff_handle: handoff,
      });
      const attachment = verifyTargetResourceReceipt({
        operation: "attach_organization",
        raw: await runTarget("attach_organization", request, signal),
        request,
        resulting_revision: 7,
        run_id: journal.request.run_id,
      });
      await complete("attach_organization", request, attachment);
      return { ...up, target_attachment: attachment };
    },
    readOrganizationReadiness: async ({ up_receipt }) => up_receipt,
  };
};
