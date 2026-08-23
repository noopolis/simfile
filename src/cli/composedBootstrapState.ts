import type {
  ComposedBootstrapCapsule,
  ComposedExecution,
  ComposedJournalSession,
  ComposedProjectPreparation,
  ComposedRunRequest,
} from "../compose/index.js";
import type { SpawnfileCompileReport } from "./compiledOrganizationIdentity.js";
import type { SpawnfileBundleRequest } from "../spawnfile/containerBundleCli.js";
import type { SpawnfileOrganizationAuthentication } from
  "../spawnfile/organizationAuthentication.js";
import type { BootstrapSpawnfileCliContext } from "../spawnfile/process.js";
import type { ComposedBootstrapPaths } from "./composedBootstrapPaths.js";
import type { ComposedCommandMode } from "./runArguments.js";
import type { ComposedCredentialProjection } from "./composedProjectDescriptor.js";
import type { SpawnfileCredentialProvisioningReceipt } from "../spawnfile/bootstrapCli.js";
import type { CliComposedTargetProvider } from "../spawnfile/composedTargetProvider.js";

export interface PreparedComposedBootstrap {
  readonly authentication: SpawnfileOrganizationAuthentication;
  readonly base_image: string;
  readonly bundle_request_base: Omit<SpawnfileBundleRequest,
    "idempotency_key" | "selected_target">;
  readonly capsule: ComposedBootstrapCapsule;
  readonly cli: BootstrapSpawnfileCliContext;
  readonly command_mode: ComposedCommandMode;
  readonly credential_projection: ComposedCredentialProjection;
  readonly docker_command: string;
  readonly journal_session: ComposedJournalSession;
  readonly paths: ComposedBootstrapPaths;
  readonly preparation: ComposedProjectPreparation;
  readonly report: SpawnfileCompileReport;
  readonly request: ComposedRunRequest;
  readonly selected_request: Readonly<Record<string, unknown>>;
  readonly source_handles?: readonly string[];
}

export interface LinkedComposedBootstrap {
  readonly auth: SpawnfileCredentialProvisioningReceipt;
  readonly command_mode: ComposedCommandMode;
  readonly compile_fingerprint: string;
  readonly execution: ComposedExecution;
  readonly journal_path: string;
  readonly journal_session: ComposedJournalSession;
  readonly organization_evidence_directory: string;
  readonly preparation: ComposedProjectPreparation;
  readonly request: ComposedRunRequest;
  readonly run_id: string;
  readonly run_path: string;
  readonly source_handles: readonly string[];
  readonly support_root: string;
  readonly target_provider: CliComposedTargetProvider;
  readonly trusted_project_root: string;
  readonly world_evidence_directory: string;
}
