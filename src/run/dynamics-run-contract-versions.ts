import { DYNAMICS_BUILD_RECEIPT_VERSION } from "../dynamics/buildReceipt.js";
import { DYNAMICS_RUN_ACTION_SOURCE_VERSION } from "../dynamics/runActionSource.js";
import { CAUSAL_ENVELOPE_VERSION } from "../ledger/stable.js";
import { RUN_MANIFEST_VERSION } from "../observe/manifest.js";
import { PROJECT_VIEWER_EXTENSIONS_VERSION } from "../viewer-extension/projectDeclaration.js";
import {
  DYNAMICS_RUN_ACTION_INGRESS_VERSION,
  DYNAMICS_RUN_ACTION_RESULT_VERSION,
  DYNAMICS_RUN_STEP_RECORD_VERSION
} from "./dynamics-run-actions.js";
import {
  DYNAMICS_RUN_FRAMES_HEADER_VERSION,
  DYNAMICS_RUN_FRAME_VERSION
} from "./dynamics-run-frames.js";
import { DYNAMICS_RUN_COMMITMENT_OUTCOME_VERSION } from
  "./dynamics-run-commitment-outcomes.js";

/**
 * v2 adds three decision-token reason values to the closed vocabulary. The
 * bump is required because readers may switch exhaustively on `reason`.
 */
export const WORLD_RUN_ACTION_REFUSAL_VERSION =
  "simfile.world-run-action-refusal.v2" as const;
export const WORLD_RUN_PERCEPTION_VERSION =
  "simfile.world-run-perception.v1" as const;
export const DYNAMICS_RUN_WALL_CLOCK_VERSION =
  "simfile.dynamics-run-wall-clock.v1" as const;

/**
 * The set of contract versions a dynamics run record declares in its
 * manifest. Extracted from `dynamics-run-record.ts` (behavior-preserving) to
 * keep that file under the repo's 400-line ceiling, and because this list is
 * the natural place to notice a new artifact that forgot to declare itself.
 *
 * The action-source versions are conditional: a run with no action source
 * writes no ingress/result records, so declaring their contracts would claim
 * artifacts the record does not contain.
 */
export const dynamicsRunContractVersions = (params: {
  hasActionSource: boolean;
  providerApiVersion: string;
  recordVersion: string;
  provenanceVersion: string;
  replayInputVersion: string;
  snapshotVersion: string;
}): Record<string, string> => ({
  [CAUSAL_ENVELOPE_VERSION]: CAUSAL_ENVELOPE_VERSION,
  [params.providerApiVersion]: params.providerApiVersion,
  [params.snapshotVersion]: params.snapshotVersion,
  [DYNAMICS_BUILD_RECEIPT_VERSION]: DYNAMICS_BUILD_RECEIPT_VERSION,
  [params.recordVersion]: params.recordVersion,
  [params.provenanceVersion]: params.provenanceVersion,
  [params.replayInputVersion]: params.replayInputVersion,
  [DYNAMICS_RUN_STEP_RECORD_VERSION]: DYNAMICS_RUN_STEP_RECORD_VERSION,
  [DYNAMICS_RUN_FRAMES_HEADER_VERSION]: DYNAMICS_RUN_FRAMES_HEADER_VERSION,
  [DYNAMICS_RUN_FRAME_VERSION]: DYNAMICS_RUN_FRAME_VERSION,
  [DYNAMICS_RUN_WALL_CLOCK_VERSION]: DYNAMICS_RUN_WALL_CLOCK_VERSION,
  [WORLD_RUN_ACTION_REFUSAL_VERSION]: WORLD_RUN_ACTION_REFUSAL_VERSION,
  [WORLD_RUN_PERCEPTION_VERSION]: WORLD_RUN_PERCEPTION_VERSION,
  [PROJECT_VIEWER_EXTENSIONS_VERSION]: PROJECT_VIEWER_EXTENSIONS_VERSION,
  ...(params.hasActionSource
    ? {
      [DYNAMICS_RUN_ACTION_INGRESS_VERSION]: DYNAMICS_RUN_ACTION_INGRESS_VERSION,
      [DYNAMICS_RUN_ACTION_RESULT_VERSION]: DYNAMICS_RUN_ACTION_RESULT_VERSION,
      [DYNAMICS_RUN_ACTION_SOURCE_VERSION]: DYNAMICS_RUN_ACTION_SOURCE_VERSION,
      [DYNAMICS_RUN_COMMITMENT_OUTCOME_VERSION]:
        DYNAMICS_RUN_COMMITMENT_OUTCOME_VERSION
    }
    : {}),
  [RUN_MANIFEST_VERSION]: RUN_MANIFEST_VERSION
});
