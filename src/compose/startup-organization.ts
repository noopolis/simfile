import { digestComposedJson } from "./json.js";
import { parseComposedPhaseJournal, type ComposedPhaseJournal } from "./journal.js";
import {
  commitComposedPhase,
  composedPhasePayload,
  composedPhaseReached,
  type ComposedPhaseContext,
} from "./phase.js";
import {
  verifyComposedOrganizationUpReceipt,
  type ComposedOrganizationExpectation,
  type ComposedOrganizationUpReceipt,
} from "./startupOrganizationReceipt.js";

export {
  deriveComposedOrganizationDeploymentHandle,
  verifyComposedOrganizationUpReceipt,
  type ComposedOrganizationExpectation,
  type ComposedOrganizationUpReceipt,
} from "./startupOrganizationReceipt.js";

export interface ComposedOrganizationStartupPort {
  startOrganization(input: Readonly<{ idempotency_key: string; run_id: string;
    signal: AbortSignal; world_readiness_digest: string }>): Promise<unknown>;
  readOrganizationReadiness(input: Readonly<{ up_receipt: ComposedOrganizationUpReceipt;
    signal: AbortSignal }>): Promise<unknown>;
}

const operationKey = (journal: ComposedPhaseJournal, operation: string): string =>
  `idem_${digestComposedJson("simfile.composed-organization-operation.v1", {
    operation, request_digest: journal.request_digest,
  }).slice(7, 39)}`;

/** Starts the organization only after world-only readiness, then proves bindings. */
export const startComposedOrganization = async (input: Readonly<{
  context: ComposedPhaseContext;
  expectation: ComposedOrganizationExpectation;
  journal: unknown;
  port: ComposedOrganizationStartupPort;
  signal?: AbortSignal;
}>): Promise<ComposedPhaseJournal> => {
  let journal = parseComposedPhaseJournal(input.journal);
  if (!composedPhaseReached(journal, "world_ready")) {
    throw new TypeError("composed organization startup requires world readiness");
  }
  const worldReadinessDigest = composedPhasePayload(journal, "world_ready").readiness_digest;
  if (typeof worldReadinessDigest !== "string") {
    throw new TypeError("composed world readiness digest is unavailable");
  }
  const signal = input.signal ?? new AbortController().signal;
  if (!composedPhaseReached(journal, "organization_started")) {
    const receipt = verifyComposedOrganizationUpReceipt({ expectation: input.expectation,
      raw: await input.port.startOrganization({
        idempotency_key: operationKey(journal, "start_organization"),
        run_id: journal.request.run_id, signal, world_readiness_digest: worldReadinessDigest,
      }), require_ready: false, run_id: journal.request.run_id });
    journal = await commitComposedPhase(journal, "organization_started", {
      run_id: journal.request.run_id, up_receipt: receipt,
      up_receipt_digest: digestComposedJson("spawnfile.up-receipt.v1", receipt),
    }, input.context);
  }
  if (!composedPhaseReached(journal, "organization_ready")) {
    const started = verifyComposedOrganizationUpReceipt({ expectation: input.expectation,
      raw: composedPhasePayload(journal, "organization_started").up_receipt,
      require_ready: false, run_id: journal.request.run_id });
    const ready = verifyComposedOrganizationUpReceipt({ expectation: input.expectation,
      raw: await input.port.readOrganizationReadiness({ signal, up_receipt: started }),
      require_ready: true, run_id: journal.request.run_id });
    journal = await commitComposedPhase(journal, "organization_ready", {
      moltnet_release: ready.moltnet_release ?? null,
      organization_handoff: ready.organization_handoff, readiness: ready.organization_ready,
      receipt_digest: digestComposedJson("spawnfile.up-receipt.v1", ready),
      run_id: journal.request.run_id,
    }, input.context);
  }
  return journal;
};
